package io.amar.console.data.chat

import android.content.Context
import io.amar.console.core.HubClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * E2EE Matrix attachment decryption — Kotlin port of the SPA's
 * decryptAttachment (src/matrix/decrypt-media.ts). The scheme is the Matrix
 * EncryptedFile spec: AES-CTR-256, JWK key with base64url `k`, unpadded
 * base64 `iv` (upper 64 bits random counter prefix, lower 64 bits zero).
 *
 * Downloads the encrypted blob via the hub media proxy (bearer via
 * HubClient), decrypts, and caches the plaintext at
 * cacheDir/e2ee-media/<sha1(mxc)> so re-opens are offline + instant.
 * The cache dir is exported via FileProvider (file_paths.xml `e2ee_media`)
 * for ACTION_VIEW of videos/files.
 */
object E2eeMedia {
    private val json = Json { ignoreUnknownKeys = true }

    const val CACHE_DIR = "e2ee-media"

    /** Pure AES-CTR decrypt: [keyB64Url] = JWK `k` (base64url, unpadded),
     *  [ivB64] = EncryptedFile `iv` (unpadded base64). */
    fun decrypt(encrypted: ByteArray, keyB64Url: String, ivB64: String): ByteArray {
        val key = base64UrlDecode(keyB64Url)
        val iv = base64Decode(ivB64)
        val cipher = Cipher.getInstance("AES/CTR/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
        return cipher.doFinal(encrypted)
    }

    /** Matrix base64url (unpadded, URL-safe) → bytes. */
    fun base64UrlDecode(s: String): ByteArray =
        android.util.Base64.decode(s, android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP)

    /** Matrix unpadded standard base64 → bytes (tolerates padding + url-safe chars). */
    fun base64Decode(s: String): ByteArray =
        android.util.Base64.decode(
            s.replace('-', '+').replace('_', '/'),
            android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP,
        )

    /** Stable cache filename for an event's media. */
    fun cacheFile(context: Context, mxcUrl: String, filename: String? = null): File {
        val dir = File(context.cacheDir, CACHE_DIR).apply { mkdirs() }
        val digest = MessageDigest.getInstance("SHA-1")
            .digest(mxcUrl.toByteArray())
            .joinToString("") { "%02x".format(it) }
        // Keep the extension when known so ACTION_VIEW mime sniffing works.
        val ext = filename?.substringAfterLast('.', "")?.takeIf { it.length in 1..5 && it.all { c -> c.isLetterOrDigit() } }
        return File(dir, if (ext != null) "$digest.$ext" else digest)
    }

    /**
     * Download (via hub media proxy) + decrypt + cache. [encryptedFileJson]
     * is the Matrix EncryptedFile content ({url, key:{k}, iv, ...}) as stored
     * on ChatMessageRow.encryptedFileJson. Returns the plaintext file.
     * Cached files are reused (offline re-open works).
     */
    suspend fun decryptedFile(
        context: Context,
        hub: HubClient,
        encryptedFileJson: String,
        filename: String? = null,
    ): File = withContext(Dispatchers.IO) {
        val file = json.parseToJsonElement(encryptedFileJson).jsonObject
        val mxc = file["url"]?.jsonPrimitive?.content ?: throw IllegalArgumentException("no url")
        val keyB64 = file["key"]?.jsonObject?.get("k")?.jsonPrimitive?.content
            ?: throw IllegalArgumentException("no key")
        val ivB64 = file["iv"]?.jsonPrimitive?.content ?: throw IllegalArgumentException("no iv")

        val out = cacheFile(context, mxc, filename)
        if (out.exists() && out.length() > 0) return@withContext out

        val httpUrl = MatrixMedia.downloadUrl(mxc) ?: throw IllegalArgumentException("bad mxc: $mxc")
        val encrypted = hub.getRaw(httpUrl).use { resp ->
            resp.body?.bytes() ?: throw IllegalStateException("empty body")
        }
        val plain = decrypt(encrypted, keyB64, ivB64)
        // Atomic-ish write: temp sibling then rename so a killed process
        // can't leave a truncated file that reads as cached.
        val tmp = File(out.parentFile, "${out.name}.tmp")
        tmp.writeBytes(plain)
        if (!tmp.renameTo(out)) {
            out.writeBytes(plain)
            tmp.delete()
        }
        out
    }

    /**
     * Plain (non-E2EE) media download to the same cache — used by the
     * video/file open path when the room isn't encrypted.
     */
    suspend fun downloadedFile(
        context: Context,
        hub: HubClient,
        mxcUrl: String,
        filename: String? = null,
    ): File = withContext(Dispatchers.IO) {
        val out = cacheFile(context, mxcUrl, filename)
        if (out.exists() && out.length() > 0) return@withContext out
        val httpUrl = MatrixMedia.downloadUrl(mxcUrl) ?: throw IllegalArgumentException("bad mxc: $mxcUrl")
        val bytes = hub.getRaw(httpUrl).use { resp ->
            resp.body?.bytes() ?: throw IllegalStateException("empty body")
        }
        val tmp = File(out.parentFile, "${out.name}.tmp")
        tmp.writeBytes(bytes)
        if (!tmp.renameTo(out)) {
            out.writeBytes(bytes)
            tmp.delete()
        }
        out
    }

    /**
     * Resolve a message's media to a local plaintext file: decrypt when the
     * event carries EncryptedFile material, plain download otherwise.
     */
    suspend fun mediaFile(
        context: Context,
        hub: HubClient,
        msg: io.amar.console.data.db.ChatMessageRow,
    ): File {
        val filename = msg.body?.takeIf { it.contains('.') }
        return if (msg.encryptedFileJson != null) {
            decryptedFile(context, hub, msg.encryptedFileJson, filename)
        } else {
            val mxc = msg.mediaMxc ?: throw IllegalArgumentException("no media")
            downloadedFile(context, hub, mxc, filename)
        }
    }
}
