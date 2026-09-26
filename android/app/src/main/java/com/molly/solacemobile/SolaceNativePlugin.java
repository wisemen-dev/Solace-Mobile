package com.molly.solacemobile;

import android.content.ClipData;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
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
 * - 读取 SAF 文档内容为 base64（桥内转 Uint8Array 走既有导入链）
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
    }

    @PluginMethod
    public void launchApp(PluginCall call) {
        String pkg = call.getString("package", "");
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
        JSObject res = new JSObject();
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null) {
            res.put("canceled", true);
            call.resolve(res);
            return;
        }
        Uri uri = result.getData().getData();
        try {
            // 持久化读权限：重启后免再次授权（每次安装新 APK 权限保留）
            getContext().getContentResolver().takePersistableUriPermission(uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException ignored) {
            // 部分 ROM 不支持持久化：本次会话仍可读，下次需重选
        }
        res.put("canceled", false);
        res.put("uri", uri.toString());
        res.put("name", queryDisplayName(uri));
        call.resolve(res);
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
                    walkTree(tree, id, out, depth + 1);
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

    @PluginMethod
    public void readFileBase64(PluginCall call) {
        String uri = call.getString("uri", "");
        io.execute(() -> {
            JSObject res = new JSObject();
            try (InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(uri))) {
                if (in == null) throw new IllegalStateException("无法打开文件");
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                byte[] chunk = new byte[65536];
                int n;
                while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
                res.put("base64", Base64.encodeToString(buf.toByteArray(), Base64.NO_WRAP));
            } catch (Exception e) {
                res.put("error", "读取失败：" + e.getMessage());
            }
            call.resolve(res);
        });
    }

    /* ---- 原生导入管线（性能关键路径） ----
       文件内容经 JS 桥以 base64 往返会让主线程卡死数秒（实测纯 JS 编码
       10MB≈1.1s，全部阻塞 UI）；以下三条方法让内容全程不过 JS：
       SAF 多选 → 原生流式哈希 → 原生流式复制进资料库 */

    @PluginMethod
    public void pickPdfs(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        intent.setType("application/pdf");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        // 部分来源的 PDF 登记为 octet-stream，补进候选类型避免选不到
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/pdf", "application/octet-stream"});
        startActivityForResult(call, intent, "pickPdfsResult");
    }

    @ActivityCallback
    private void pickPdfsResult(PluginCall call, ActivityResult result) {
        JSObject res = new JSObject();
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null) {
            res.put("canceled", true);
            call.resolve(res);
            return;
        }
        JSArray files = new JSArray();
        ClipData clip = result.getData().getClipData();
        Uri single = result.getData().getData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) files.put(docEntry(clip.getItemAt(i).getUri()));
        } else if (single != null) {
            files.put(docEntry(single));
        }
        res.put("canceled", false);
        res.put("files", files);
        call.resolve(res);
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

    // 资料库根（与 fs-adapter 的 Directory.External + SolaceLibrary 同一位置）
    private File libraryFile(String relPath) {
        File base = new File(getContext().getExternalFilesDir(null), "SolaceLibrary");
        return new File(base, relPath == null ? "" : relPath);
    }

    // 流式 SHA-256（MessageDigest 原生实现，~GB/s 级），内容不过 JS
    @PluginMethod
    public void hashUri(PluginCall call) {
        String uri = call.getString("uri", "");
        io.execute(() -> {
            JSObject res = new JSObject();
            try (InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(uri))) {
                if (in == null) throw new IllegalStateException("无法打开文件");
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                byte[] buf = new byte[262144];
                long total = 0;
                int n;
                while ((n = in.read(buf)) > 0) {
                    md.update(buf, 0, n);
                    total += n;
                }
                res.put("hash", toHex(md.digest()));
                res.put("size", total);
            } catch (Exception e) {
                res.put("error", String.valueOf(e.getMessage()));
            }
            call.resolve(res);
        });
    }

    // 流式复制 SAF 文档 → 资料库相对路径；失败清掉半截文件
    @PluginMethod
    public void copyUri(PluginCall call) {
        String uri = call.getString("uri", "");
        String destPath = call.getString("destPath", "");
        io.execute(() -> {
            JSObject res = new JSObject();
            File dest = libraryFile(destPath);
            try (InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(uri))) {
                if (in == null) throw new IllegalStateException("无法打开文件");
                //noinspection ResultOfMethodCallIgnored
                dest.getParentFile().mkdirs();
                long total = 0;
                try (FileOutputStream out = new FileOutputStream(dest)) {
                    byte[] buf = new byte[262144];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        total += n;
                    }
                }
                res.put("size", total);
            } catch (Exception e) {
                //noinspection ResultOfMethodCallIgnored
                dest.delete();
                res.put("error", "复制失败：" + e.getMessage());
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
