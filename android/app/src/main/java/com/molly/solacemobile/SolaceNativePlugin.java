package com.molly.solacemobile;

import android.content.ClipData;
import android.content.Intent;
import android.content.UriPermission;
import android.content.pm.ResolveInfo;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Solace 的少量原生能力（官方插件没有覆盖的部分）：
 * - 按包名拉起外部应用（Olib 下载器），按关键字检索可启动应用
 * - SAF 目录授权（ACTION_OPEN_DOCUMENT_TREE + 持久化读权限）
 * - 递归枚举授权目录下的 PDF（DocumentsContract 树查询）
 * - 原生流式复制 + SHA-256（内容不过 JS 桥的导入管线）
 *
 * 文件 IO 走单线程执行器：插件方法默认在主线程执行，枚举/读取大文件
 * 必须让出（call.resolve 线程安全，从工作线程回包没有问题）。
 */
@CapacitorPlugin(name = "SolaceNative")
public class SolaceNativePlugin extends Plugin {

    private final ExecutorService io = Executors.newSingleThreadExecutor();

    /* ---- 应用启动（对应桌面端 spawn 外部工具） ---- */

    @PluginMethod
    public void findApps(PluginCall call) {
        String keyword = call.getString("keyword", "");
        // 全量枚举 + 逐个 loadLabel 都是重活（Olib 检测还会按多关键字连查），
        // 必须让出主线程，否则设置面板「检测…」期间界面冻结
        io.execute(() -> {
            String kw = keyword == null ? "" : keyword.toLowerCase();
            Intent main = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
            List<ResolveInfo> apps = getContext().getPackageManager().queryIntentActivities(main, 0);
            JSArray out = new JSArray();
            for (ResolveInfo app : apps) {
                String pkg = app.activityInfo.packageName;
                String label = String.valueOf(app.loadLabel(getContext().getPackageManager()));
                if (!kw.isEmpty() && !pkg.toLowerCase().contains(kw) && !label.toLowerCase().contains(kw)) continue;
                JSObject o = new JSObject();
                o.put("package", pkg);
                o.put("label", label);
                out.put(o);
            }
            JSObject res = new JSObject();
            res.put("apps", out);
            call.resolve(res);
        });
    }

    @PluginMethod
    public void launchApp(PluginCall call) {
        String pkg = call.getString("package", "");
        // 包解析同样是 PackageManager 查询，放到 io 线程与 findApps 保持一致
        io.execute(() -> {
            JSObject res = new JSObject();
            try {
                Intent intent = pkg == null ? null : getContext().getPackageManager().getLaunchIntentForPackage(pkg);
                if (intent == null) {
                    res.put("ok", false);
                    call.resolve(res);
                    return;
                }
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                res.put("ok", true);
            } catch (Exception e) {
                res.put("ok", false);
                res.put("error", String.valueOf(e.getMessage()));
            }
            call.resolve(res);
        });
    }

    /* ---- SAF 目录授权（对应桌面端的「选择监视文件夹」） ---- */

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "pickFolderResult");
    }

    @ActivityCallback
    private void pickFolderResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null) {
            JSObject canceled = new JSObject();
            canceled.put("canceled", true);
            call.resolve(canceled);
            return;
        }
        Uri uri = result.getData().getData();
        if (uri == null) {
            // 个别 ROM 会回 RESULT_OK 但不带 URI：按取消处理，否则 io 线程 NPE
            // 会让 JS 端 promise 永不落定（「浏览…」静默卡死）
            JSObject canceled = new JSObject();
            canceled.put("canceled", true);
            call.resolve(canceled);
            return;
        }
        // 持久化授权与目录名查询都是磁盘 IO，统一挪到 io 线程
        io.execute(() -> {
            JSObject res = new JSObject();
            try {
                getContext().getContentResolver().takePersistableUriPermission(uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (SecurityException ignored) {
                // 部分 ROM 不支持持久化：本次会话仍可读，下次需重选
            }
            // 系统持久化授权有上限（旧 Android 128 个）：反复换监视目录会积累
            // 旧授权，逼近上限后新授权静默失败——只保留本次的，其余释放
            for (UriPermission p : getContext().getContentResolver().getPersistedUriPermissions()) {
                if (p.getUri().equals(uri)) continue;
                try {
                    getContext().getContentResolver().releasePersistableUriPermission(p.getUri(),
                            Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (Exception ignored) {
                }
            }
            res.put("canceled", false);
            res.put("uri", uri.toString());
            res.put("name", queryDisplayName(uri));
            call.resolve(res);
        });
    }

    private String queryDisplayName(Uri uri) {
        try (Cursor c = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME);
                if (idx >= 0) return c.getString(idx);
            }
        } catch (Exception ignored) {
        }
        return "所选文件夹";
    }

    /* ---- 授权目录枚举与读取 ---- */

    @PluginMethod
    public void listPdfs(PluginCall call) {
        String uri = call.getString("uri", "");
        io.execute(() -> call.resolve(listPdfsImpl(uri)));
    }

    private JSObject listPdfsImpl(String uriStr) {
        JSObject res = new JSObject();
        JSArray files = new JSArray();
        try {
            Uri tree = Uri.parse(uriStr);
            walkTree(tree, DocumentsContract.getTreeDocumentId(tree), files, 0);
            res.put("files", files);
        } catch (Exception e) {
            res.put("error", "无法读取该文件夹：" + e.getMessage());
        }
        return res;
    }

    // 递归深度上限：下载目录通常是浅的，防环形引用/异常深目录拖死扫描
    private static final int MAX_DEPTH = 6;

    private void walkTree(Uri tree, String docId, JSArray out, int depth) throws Exception {
        if (depth > MAX_DEPTH) return;
        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId);
        try (Cursor c = getContext().getContentResolver().query(childrenUri, new String[]{
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED
        }, null, null, null)) {
            if (c == null) return;
            while (c.moveToNext()) {
                String id = c.getString(0);
                String name = c.getString(1);
                String mime = c.getString(2);
                long size = c.getLong(3);
                long mtime = c.getLong(4);
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    try {
                        walkTree(tree, id, out, depth + 1);
                    } catch (Exception ignored) {
                        // 单个子目录读取失败（Provider 抖动/权限受限）不中断整轮枚举
                    }
                } else if (name != null && name.toLowerCase().endsWith(".pdf")) {
                    JSObject o = new JSObject();
                    o.put("name", name);
                    o.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString());
                    o.put("size", size);
                    o.put("mtime", mtime);
                    out.put(o);
                }
            }
        }
    }

    /* ---- 原生导入管线（性能关键路径） ----
       文件内容经 JS 桥以 base64 往返会让主线程卡死数秒（实测纯 JS 编码
       10MB≈1.1s，全部阻塞 UI）；以下方法让内容全程不过 JS：
       SAF 多选 → 原生流式（复制 + 哈希一次完成）进资料库 */

    @PluginMethod
    public void pickPdfs(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        // 只留 application/pdf：加 octet-stream 会让选择器显示出各种二进制
        // 文件，选择体验混乱（导入侧另有文件名防线）
        intent.setType("application/pdf");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(call, intent, "pickPdfsResult");
    }

    @ActivityCallback
    private void pickPdfsResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null) {
            JSObject canceled = new JSObject();
            canceled.put("canceled", true);
            call.resolve(canceled);
            return;
        }
        ClipData clip = result.getData().getClipData();
        Uri single = result.getData().getData();
        // 文档名/大小要走 ContentResolver 查询（磁盘 IO），挪到 io 线程，
        // 不占插件默认的主线程
        io.execute(() -> {
            JSObject res = new JSObject();
            JSArray files = new JSArray();
            if (clip != null) {
                for (int i = 0; i < clip.getItemCount(); i++) files.put(docEntry(clip.getItemAt(i).getUri()));
            } else if (single != null) {
                files.put(docEntry(single));
            }
            res.put("canceled", false);
            res.put("files", files);
            call.resolve(res);
        });
    }

    // SAF 文档的展示名与大小（选择器返回的 uri 直接可查）
    private JSObject docEntry(Uri uri) {
        JSObject o = new JSObject();
        o.put("uri", uri.toString());
        String name = null;
        long size = -1;
        try (Cursor c = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int si = c.getColumnIndex(OpenableColumns.SIZE);
                if (ni >= 0) name = c.getString(ni);
                if (si >= 0 && !c.isNull(si)) size = c.getLong(si);
            }
        } catch (Exception ignored) {
        }
        o.put("name", name != null ? name : "document.pdf");
        o.put("size", size);
        return o;
    }

    // 资料库根（与 fs-adapter 的 Directory.External + SolaceLibrary 同一位置）。
    // relPath 来自 JS 桥，必须限制在库内：规范路径不含库根前缀即拒绝，
    // 防 ../ 逃逸读写库外任意应用可及路径。非法即抛 IllegalStateException
    // （RuntimeException），由调用点既有的 catch(Exception) 转成 error 响应
    private File libraryFile(String relPath) {
        File base = new File(getContext().getExternalFilesDir(null), "SolaceLibrary");
        File f = new File(base, relPath == null ? "" : relPath);
        String baseCanonical, canonical;
        try {
            baseCanonical = base.getCanonicalPath();
            canonical = f.getCanonicalPath();
        } catch (java.io.IOException e) {
            throw new IllegalStateException("路径规范化失败: " + relPath, e);
        }
        if (!canonical.equals(baseCanonical) && !canonical.startsWith(baseCanonical + File.separator)) {
            throw new IllegalStateException("路径越出资料库: " + relPath);
        }
        return f;
    }

    // 复制的同时计算 SHA-256：一次读取完成两件事，且哈希与副本内容严格
    // 同源——彻底消除「先哈希后复制」之间文件仍在被写入的竞态
    // （hash 与 copy 分两步时，库内登记的哈希可能与副本实际内容不符）
    @PluginMethod
    public void copyAndHash(PluginCall call) {
        String uri = call.getString("uri", "");
        String destPath = call.getString("destPath", "");
        io.execute(() -> {
            JSObject res = new JSObject();
            // libraryFile 的越界拒绝必须落在 try 内：lambda 里未捕获的
            // RuntimeException 会杀死 io 线程与整个进程（真机实测崩溃点）
            File dest = null;
            try {
                dest = libraryFile(destPath);
                try (InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(uri))) {
                    if (in == null) throw new IllegalStateException("无法打开文件");
                    MessageDigest md = MessageDigest.getInstance("SHA-256");
                    //noinspection ResultOfMethodCallIgnored
                    dest.getParentFile().mkdirs();
                    long total = 0;
                    try (FileOutputStream out = new FileOutputStream(dest)) {
                        byte[] buf = new byte[262144];
                        int n;
                        while ((n = in.read(buf)) > 0) {
                            out.write(buf, 0, n);
                            md.update(buf, 0, n);
                            total += n;
                        }
                    }
                    res.put("size", total);
                    res.put("hash", toHex(md.digest()));
                }
            } catch (Exception e) {
                if (dest != null) {
                    //noinspection ResultOfMethodCallIgnored
                    dest.delete();
                }
                res.put("error", "复制失败：" + e.getMessage());
            }
            call.resolve(res);
        });
    }

    // 库内文件的原生流式哈希：旧桌面库（0.9.x 之前）条目缺 hash，补算时
    // 不再走 base64 过桥的 JS 慢路径
    @PluginMethod
    public void hashLibraryPath(PluginCall call) {
        String path = call.getString("path", "");
        io.execute(() -> {
            JSObject res = new JSObject();
            try {
                File src = libraryFile(path);
                try (InputStream in = new java.io.FileInputStream(src)) {
                    MessageDigest md = MessageDigest.getInstance("SHA-256");
                    byte[] buf = new byte[262144];
                    int n;
                    while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
                    res.put("hash", toHex(md.digest()));
                }
            } catch (Exception e) {
                res.put("error", String.valueOf(e.getMessage()));
            }
            call.resolve(res);
        });
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }
}
