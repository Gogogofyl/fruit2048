package com.fruitgame.puzzle2048;

import android.app.Activity;
import android.webkit.ValueCallback;

/**
 * 返回键的 JS 回调。
 * 刻意不使用泛型形参（ValueCallback<String>），用原始类型实现，
 * 避免编译器生成额外的泛型签名信息导致 d8 解析异常。
 */
@SuppressWarnings("rawtypes")
public class BackCallback implements ValueCallback {

    private final Activity activity;

    public BackCallback(Activity activity) {
        this.activity = activity;
    }

    @Override
    public void onReceiveValue(Object value) {
        String text = value == null ? "" : value.toString();
        if (text.contains("exit")) {
            activity.moveTaskToBack(true);
        }
    }
}
