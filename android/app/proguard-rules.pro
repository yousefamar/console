# Console APK — keep JS-visible interfaces
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
