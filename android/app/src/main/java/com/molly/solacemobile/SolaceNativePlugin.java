package com.molly.solacemobile;

import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
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
import java.io.InputStream;
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
}
