package io.amar.console.data.chat

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.random.Random

/**
 * AES-CTR round-trip against a synthetic vector: encrypt with the exact
 * Matrix EncryptedFile params (256-bit key, 16-byte IV with 8 random
 * counter-prefix bytes + 8 zero bytes), then decrypt via E2eeMedia.
 */
@RunWith(RobolectricTestRunner::class)
class E2eeMediaTest {

    private fun b64Url(bytes: ByteArray): String =
        android.util.Base64.encodeToString(
            bytes,
            android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP,
        )

    private fun b64(bytes: ByteArray): String =
        android.util.Base64.encodeToString(
            bytes,
            android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP,
        )

    private fun encrypt(plain: ByteArray, key: ByteArray, iv: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/CTR/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
        return cipher.doFinal(plain)
    }

    @Test
    fun `decrypt inverts encrypt with Matrix EncryptedFile params`() {
        val plain = Random(42).nextBytes(100_000) // multi-block payload
        val key = Random(1).nextBytes(32)         // AES-256
        val iv = ByteArray(16).also { Random(2).nextBytes(it, 0, 8) } // low 64 bits zero

        val encrypted = encrypt(plain, key, iv)
        val decrypted = E2eeMedia.decrypt(encrypted, b64Url(key), b64(iv))
        assertArrayEquals(plain, decrypted)
    }

    @Test
    fun `decrypt handles unpadded base64url key and unpadded base64 iv`() {
        // 1-byte payload (sub-block) — checks CTR keystream alignment.
        val plain = byteArrayOf(0x5A)
        val key = ByteArray(32) { it.toByte() }
        val iv = ByteArray(16) { if (it < 8) (it + 1).toByte() else 0 }
        val encrypted = encrypt(plain, key, iv)
        assertArrayEquals(plain, E2eeMedia.decrypt(encrypted, b64Url(key), b64(iv)))
    }

    @Test
    fun `base64 decode tolerates url-safe chars in standard field`() {
        // Some senders emit url-safe chars in the iv field; decoder maps them.
        val iv = ByteArray(16) { (0xF8 + it).toByte() } // produces +/ chars in std b64
        val std = b64(iv)
        val urlSafe = std.replace('+', '-').replace('/', '_')
        assertArrayEquals(iv, E2eeMedia.base64Decode(urlSafe))
    }

    @Test
    fun `cache filename is stable and keeps extension`() {
        val ctx = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
        val a = E2eeMedia.cacheFile(ctx, "mxc://x/abc", "voice.ogg")
        val b = E2eeMedia.cacheFile(ctx, "mxc://x/abc", "voice.ogg")
        assertEquals(a.absolutePath, b.absolutePath)
        assertEquals("ogg", a.extension)
        // Different mxc → different file.
        val c = E2eeMedia.cacheFile(ctx, "mxc://x/other", "voice.ogg")
        assert(a.absolutePath != c.absolutePath)
    }
}
