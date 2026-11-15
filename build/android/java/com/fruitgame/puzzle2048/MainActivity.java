package com.fruitgame.puzzle2048;

import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;

/**
 * 最小壳：整屏一个 WebView 装载打包在 assets 里的游戏。
 *
 * 不用 file:// 而是拦截虚拟的 https 域名 local.game，
 * 因为 file:// 源在部分 Android WebView 上 localStorage 不可靠，
 * 会导致存档丢失；https 源则完全支持 DOM storage。
 */
public class MainActivity extends Activity {

    private static final String START_URL = "https://" + AssetClient.HOST + "/www/index3d.html";

    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#f7efe2"));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        // 存档靠 localStorage，必须开
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        // 背景音乐用 Audio 播，不能被"需要用户手势"卡住
        s.setMediaPlaybackRequiresUserGesture(false);
        // 资源都在 assets 里，不命中旧缓存
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        // 不跟随系统字体缩放，免得界面被撑变形
        s.setTextZoom(100);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            web.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        }

        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new AssetClient(this));

        setContentView(web);
        web.loadUrl(START_URL);
    }

    @Override
    public void onBackPressed() {
        if (web == null) {
            moveTaskToBack(true);
            return;
        }
        // 有弹层先关弹层；没弹层就打开菜单；菜单已开再按一次才退出到后台
        web.evaluateJavascript(
            "(function(){try{"
                + "var g=window.__game;"
                + "if(g&&g.renderer){"
                + "var m=g.renderer.modal;"
                + "if(m==='menu'){return 'exit';}"
                + "if(m){g.renderer.closeSheets();return 'closed';}"
                + "g.renderer.openMenu();return 'menu';"
                + "}"
                + "return 'exit';"
                + "}catch(e){return 'exit';}})()",
            new BackCallback(this)
        );
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
