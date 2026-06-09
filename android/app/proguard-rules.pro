# Console APK — keep JS-visible interfaces
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# androidx.security:security-crypto pulls in Tink, which references
# com.google.errorprone.annotations.* without packaging them. R8 warns about
# the missing classes; they're annotations only (compile-time), so safe to
# suppress.
-dontwarn com.google.errorprone.annotations.CanIgnoreReturnValue
-dontwarn com.google.errorprone.annotations.CheckReturnValue
-dontwarn com.google.errorprone.annotations.Immutable
-dontwarn com.google.errorprone.annotations.RestrictedApi
