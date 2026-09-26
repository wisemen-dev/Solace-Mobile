package com.molly.solacemobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    // 自有原生插件（拉起 Olib / SAF 目录授权与扫描），须在 super.onCreate 前注册
    registerPlugin(SolaceNativePlugin.class);
    super.onCreate(savedInstanceState);
  }
}
