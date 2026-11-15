package com.fruitgame.puzzle2048;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * 把虚拟域名 local.game 的请求映射到 assets 里的文件。
 * 单独成类，不用匿名内部类（d8 对匿名类解析不稳）。
 */
public class AssetClient extends WebViewClient {

    static final String HOST = "local.game";

    private static final Map<String, String> MIME = new HashMap<>();

    static {
        MIME.put("html", "text/html");
        MIME.put("js", "application/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("ico", "image/x-icon");
        MIME.put("svg", "image/svg+xml");
        MIME.put("wav", "audio/wav");
        MIME.put("mp3", "audio/mpeg");
        MIME.put("txt", "text/plain");
    }

    private final Context context;

    public AssetClient(Context context) {
        this.context = context;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (uri == null || !HOST.equals(uri.getHost())) {
            return null;
        }
        String path = uri.getPath();
        if (path == null || path.isEmpty()) {
            return null;
        }
        String assetPath = path.startsWith("/") ? path.substring(1) : path;
        if (assetPath.contains("..")) {
            return null;
        }
        String ext = "";
        int dot = assetPath.lastIndexOf('.');
        if (dot >= 0) {
            ext = assetPath.substring(dot + 1).toLowerCase();
        }
        String mime = MIME.get(ext);
        if (mime == null) {
            mime = "application/octet-stream";
        }
        try {
            InputStream is = context.getAssets().open(assetPath);
            String enc = null;
            if (mime.startsWith("text/") || "application/javascript".equals(mime)
                    || "application/json".equals(mime)) {
                enc = "utf-8";
            }
            return new WebResourceResponse(mime, enc, is);
        } catch (IOException e) {
            return null;
        }
    }
}
