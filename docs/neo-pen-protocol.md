# NeoLAB Neo Smartpen — BLE Protocol Reference (ProtocolV2 / N2 family)

This is the authoritative protocol reference for Console's Neo smartpen
integration, targeting the **Moleskine Pen+ (model NWP-F130, firmware 3.02)**,
which is part of NeoLAB's **N2** pen family and speaks **ProtocolV2**. Sibling of
`docs/g1-protocol.md`.

The intended Console use is a **data-rescue tool**: pulling stored ("offline")
handwriting off the pen's flash. The single most load-bearing fact in this whole
document is the **offline-erase semantics** (§7) — get that wrong and you destroy
the user's irreplaceable notes.

---

## 0. Provenance / sources

Everything below is derived by reading NeoLAB's own open-source SDKs. No on-device
verification has been done yet — anything marked `TODO: confirm on device` is an
inference from the code that should be checked against a real NWP-F130 before being
trusted.

- **AndroidSDK2.0 (Java)** — the primary, gold-source. Cloned at
  `/tmp/pen-research/AndroidSDK2.0/NASDK2.0_Studio/app/src/main/java/kr/neolab/sdk/`.
  Key files (paths below are relative to that root):
  - `pen/bluetooth/comm/CommProcessor20.java` (3963 L) — **the ProtocolV2 parser +
    command sender.** The receive dispatch is the `parsePacket()` switch
    (`comm/CommProcessor20.java:598`); the host→pen request methods are the
    `req*()` methods near the bottom (`:3249`–`:3460`).
  - `pen/bluetooth/lib/CMD20.java` — the **master opcode list** (every command +
    event constant). This is the canonical numbering.
  - `pen/bluetooth/lib/ProtocolParser20.java` — the **packet builders**
    (`build*()`), the frame parser (`parseOneByteDataEscape`/`parseOneByte`), and
    the `PacketBuilder` (framing + escaping). Definitive for wire layout.
  - `pen/bluetooth/lib/Packet.java` — receive-side packet structure
    (`getResultCode`, `getDataRangeInt`, the data-start offset).
  - `pen/bluetooth/lib/Chunk.java` — `calcChecksum()` (the 8-bit additive checksum).
  - `pen/bluetooth/BTLEAdt.java` (2336 L) — **BLE/GATT layer**: service +
    characteristic UUIDs, MTU negotiation, scan filter, write queue.
  - `pen/bluetooth/ConvertToPacket.java` — **ProtocolV1 framing helper.** Its dot
    opcodes `0x63/0x64/0x65` are **V1/legacy** (or an internal re-encoding) and are
    NOT the live V2 event codes — do not use them for an F130. The genuine V2 codes
    are in `CMD20.java` and the `CommProcessor20.parsePacket()` switch. (This file
    is included only because the task brief flagged those numbers; they are a trap.)
  - `pen/bluetooth/comm/CommProcessor.java` (1930 L) — **ProtocolV1** parser, for
    contrast only. F130 is V2; do not use V1.
  - `pen/offline/OfflineByteParser.java` — the **stored-stroke byte format**
    (stroke header + dot records + per-stroke checksum).
  - `pen/penmsg/PenMsgType.java`, `JsonTag.java` — the SDK's own event/callback
    surface (useful for naming, not wire format).
  - `ink/structure/Dot.java`, `DotType.java`, `Stroke.java` — dot/stroke structures
    + dot-type constants + coordinate encoding.
- **WEB-SDK2.0 (TypeScript)** — `/tmp/pen-research/WEB-SDK2.0/src/`. A faithful TS
  port of the same protocol; used here purely as a **cross-check** on constants and
  payload layouts. Key files: `PenCotroller/CMD.ts` (opcode constants — note the
  dir is misspelled "PenCotroller"), `PenCotroller/PenRequestV2.ts` (builders),
  `PenCotroller/PenClientParserV2.ts` (parser + offline chunk handling),
  `PenCotroller/PenHelper.ts` (Web-Bluetooth UUIDs), `Util/ByteUtil.ts` (checksum).
- **Documentations/** — `/tmp/pen-research/Documentations/` has NeoLAB's NeoNote
  data-format PDFs. Not needed for the BLE protocol; the Ncode page-address model is
  fully derivable from the SDKs.

### Known caveats / traps
- **V1 vs V2.** Two entirely separate command processors exist. F130 = **V2**
  (`CommProcessor20` / `CMD20` / `ProtocolParser20`). Everything in `CommProcessor`
  (no "20") and the `0x63/0x64/0x65` dot codes in `ConvertToPacket` is V1/legacy.
- **Event frames and response frames have different headers** (an extra
  `resultCode` byte on responses). The data-field byte offsets in §5/§6 are relative
  to the *data* start, which differs by frame class — see §4.
- The `RES_Password` "status" handling has a confusing branch where `status == 1`
  ("old password wrong") is on the *authenticated* path; this is a real SDK quirk,
  documented in §5.2, not a transcription error.
- No on-device capture has been done. Treat byte offsets as "what the SDK reads",
  which is strong evidence but not a live confirmation.

---

## 1. Hardware summary

- **Single BLE peripheral** (unlike the G1's dual L/R arms) — one GATT connection,
  one write characteristic, one notify/indicate characteristic.
- Model **NWP-F130** (Moleskine Pen+), NeoLAB **N2** family, firmware **3.02**,
  **ProtocolV2**.
- The pen reports its own identity in `RES_PenInfo` (0x81): device name (16 B),
  firmware version (16 B), protocol version (8 B), sub-name (16 B), pen type
  (`CommProcessor20.java:630`–`:634`). For an F130 you should see `deviceName` like
  `NWP-F130` and `protocolVer` ≈ `"2.xx"`. `TODO: confirm on device` (exact strings).
- Ncode digital-paper pen: writing position is read optically from the Ncode dot
  pattern and reported as a **page address** = `section / owner / note / page`
  (the Ncode address) plus an (x, y) within the page (§5.4).
- Pressure sensor; reports `maxPress` in `RES_PenStatus` (`:761`; defaults to 852 if
  the pen reports 0). Tilt (x, y) and twist are present in the V2 dot record but
  `TODO: confirm` whether F130 populates them (some models leave them 0).
- **Scan/identity filter is by MAC prefix, not advertised name.** `BTLEAdt` allows
  `9C:7B:D2` and denies `9C:7B:D2:01` (`BTLEAdt.java:139`, `:143`, used at `:731`).
  There is **no device-name regex** in the Android SDK — the advertised local name
  is read after connect (`device.getName()`, `BTLEAdt.java:349`) but not used to
  filter. `TODO: confirm on device` what the F130 advertises as its local name.

---

## 2. GATT

The pen exposes a single proprietary service. The SDK supports two UUID "versions"
(V2 and a newer "V5" 128-bit set); the SDK default is `curr_uuid_ver = UUID_VER.VER_2`
(`BTLEAdt.java:148`–`:150`, `:156`).

> **⚠ DEVICE-VERIFIED CORRECTION (2026-06-25):** Yousef's actual NWP-F130 (fw 3.02, BLE
> name "Smart Pen", sub-name "Smart Pen") does **NOT** expose `0x19F1`. Its GATT is the
> **V5 128-bit set**: service `4f99f138-9d53-5bfa-9e50-b147491afe68`, write
> `8bc8cc7d-88ca-56b0-af9a-9bf514d0d61a` (props `0x08` = WRITE), notify/indicate
> `64cd86b1-2256-5aeb-9f04-2caf6c60ae57` (props `0x30` = NOTIFY|INDICATE). It advertises a
> **name** ("Smart Pen") but **not** the service UUID — so BLE discovery must scan
> unfiltered and match by name, NOT by a `0x19F1` service filter. The application protocol
> is unchanged: `RES_PenInfo` confirmed `NWP-F130` / fw `3.02` / protocol `2.20`. Console's
> `PenBleManager` tries `0x19F1` then falls back to the V5 service.

| Role                 | UUID (128-bit, as in Android SDK)            | 16-bit short |
|----------------------|----------------------------------------------|--------------|
| Service              | `000019F1-0000-1000-8000-00805F9B34FB`       | `0x19F1`     |
| Write (host→pen)     | `00002BA0-0000-1000-8000-00805F9B34FB`       | `0x2BA0`     |
| Notify/Indicate (pen→host) | `00002BA1-0000-1000-8000-00805F9B34FB` | `0x2BA1`     |
| CCCD descriptor      | `00002902-0000-1000-8000-00805F9B34FB`       | `0x2902`     |

The 16-bit forms are confirmed by the Web SDK (`PenHelper.ts:7`–`:9`:
`serviceUuid = 0x19F1`, `characteristicUuidNoti = 0x2BA1`,
`characteristicUuidWrite = 0x2BA0`). On Web-Bluetooth the scan filter is
`{ services: [0x19F1] }` (`PenHelper.ts:215`).

- **Notifications are enabled as INDICATE when available, else NOTIFY**
  (`BTLEAdt.java:2118`–`:2126`). The pen→host characteristic (`0x2BA1`) is set up
  via `setCharacteristicIndication(..., true)` (`:2154`). Write the CCCD
  (`0x2902`) with `ENABLE_INDICATION_VALUE` (or `ENABLE_NOTIFICATION_VALUE`) before
  expecting any inbound traffic.
- **Writes use the default write type (write-with-response).** The Android write
  loop waits on `onCharacteristicWrite` before releasing the next chunk
  (`BTLEAdt.java:1735`–`:1745`, `:1981`). It does **not** set
  `WRITE_TYPE_NO_RESPONSE`. `TODO: confirm on device` whether no-response also works
  (the G1 uses no-response; this pen's SDK relies on the write callback for flow
  control).
- **MTU.** After `STATE_CONNECTED`, the SDK requests MTU from a descending list
  `{512, 256, 160, 64, 23}` (`BTLEAdt.java:175`, request at `:1903`), falling back
  to the next on failure (`onMtuChanged`, `:2038`–`:2057`). Service discovery is
  deferred until *after* MTU is set (`gatt.discoverServices()` in `onMtuChanged`,
  `:2046`). A firmware-team comment says **160 is recommended; 256 is faster when it
  succeeds** (`:174`). Outbound packets larger than the MTU are split into
  `mtu - 3` byte GATT writes (`BTLEAdt.java:1724`) — i.e. application-layer frames
  (§4) span multiple GATT writes; the pen reassembles by the `0xC0…0xC1` markers.

### Connection sequence (Android)
1. Connect GATT → `STATE_CONNECTED` → `requestMtu(512)` (descend on failure).
2. `onMtuChanged(success)` → `discoverServices()`.
3. `onServicesDiscovered` → find service `0x19F1` → start the read thread +
   `initCharacteristic()` (resolve write `0x2BA0` + indicate `0x2BA1`, write CCCD).
   (`BTLEAdt.java:1936`–`:1958`.)
4. `onDescriptorWrite` (CCCD ack) → `StartConnection()` →
   `CommProcessor20.reqPenInfo()` sends `REQ_PenInfo` (0x01)
   (`BTLEAdt.java:2009`, `:2158`–`:2163`).
5. The establish/auth handshake then proceeds entirely over the application
   protocol — see §5.1–§5.2.

---

## 4. Frame format, escaping, checksum

### 4.1 Frame layout

Every application frame is delimited by a **start byte `0xC0`** and an **end byte
`0xC1`** (`ProtocolParser20.java:47`–`:48`: `PKT_START = 0xC0`, `PKT_END = 0xC1`).

The **length is a 2-byte LITTLE-ENDIAN** field
(`ByteConverter.shortTobyte`/`byteArrayToShort`; written in `PacketBuilder.allocate`
at `ProtocolParser20.java:1418`–`:1421`). It counts **payload (data) bytes only** —
not the cmd, not the markers, not the length field, not the result byte.

There are **two frame classes**, distinguished by whether the command byte is an
"event" code. `CMD20.isEventCMD(cmd)` returns true for `0x60..0x6F`, `0x78..0x7F`,
plus `RES_OfflineChunk (0x24)` and `RES_EventUploadPenFWChunk (0x32)`
(`CMD20.java:278`–`:291`).

**Host→pen requests, and pen→host *responses* (non-event):**

```
0xC0 | cmd(1) | resultCode(1) | len_lo | len_hi | data[len] | 0xC1
```

- On **outbound requests** the host writes `resultCode = 0x00`
  (`PacketBuilder.allocate(length, errorCode)` at `ProtocolParser20.java:1447`; the
  no-error builder `allocate(length)` at `:1417` actually omits the error byte and
  writes `cmd,len_lo,len_hi` directly — most request builders use the 1-arg form, so
  the request header is effectively `cmd | len_lo | len_hi`). 
  Receive-side `Packet` for a non-event response reads `resultCode = buffer[1]` and
  `data` from **offset 4** (`Packet.java:121`–`:123`).
- `resultCode`/`getResultCode()` `0x00 = success`, non-zero = failure
  (`ProtocolParser20.java:33`–`:42`: `PKT_RESULT_SUCCESS=0x00`, `FAIL=0x01`,
  `FAIL2=0x02`). On a non-success response the parser truncates and dispatches a
  short error packet (`parseOneByte`, `:237`–`:247`).

**Pen→host events:**

```
0xC0 | cmd(1) | len_lo | len_hi | data[len] | 0xC1
```

- No result byte. Receive-side `Packet` reads `data` from **offset 3**
  (`Packet.java:128`–`:129`). The event-vs-response branch in the streaming parser
  is `parseOneByte` (`ProtocolParser20.java:202`–`:260`).

> **Practical consequence:** all the `pack.getDataRangeInt(off, n)` offsets quoted in
> §5/§6 are relative to the **data field**, i.e. *after* the header. The header size
> differs (4 bytes for a response with result byte, 3 for an event). When you build
> your own parser, strip the header per frame class first, then apply the offsets.

### 4.2 Byte-stuffing (escaping)

Inside the frame (everything between `0xC0` and `0xC1`, exclusive), any byte equal to
`0xC0`, `0xC1`, or **`0x7D` (DLE)** is escaped as:

```
0x7D , (originalByte XOR 0x20)
```

(`PKT_DLE = 0x7D`, `PKT_ESCAPE = 0x20`; encoder in `PacketBuilder.getPacket()`
`ProtocolParser20.java:1518`–`:1543`; decoder in `parseOneByteDataEscape`
`:118`–`:164`.) The decoder un-escapes symmetrically: on seeing `0x7D` it sets a DLE
flag and XORs the *next* byte with `0x20` (`escapeData`, `:166`–`:169`). The
start/end markers themselves are never escaped (they're added outside the escape
loop). The length field IS inside the escaped region, so a length byte of
`0xC0/0xC1/0x7D` is also stuffed — your decoder must un-stuff *before* interpreting
the length.

### 4.3 Checksum

The protocol's data-integrity check is a **simple 8-bit additive checksum**: sum all
the bytes, keep the low 8 bits.

```java
// Chunk.calcChecksum (lib/Chunk.java:164)
int CheckSum = 0;
for (b : bytes) CheckSum += (b & 0xFF);
return (byte) CheckSum;   // low 8 bits
```

Confirmed identical in the Web SDK (`Util/ByteUtil.ts:197`–`:206`,
`CheckSum & 0xff`). This checksum is **not** a per-BLE-frame field at the transport
layer — the frame integrity is the `0xC0…0xC1` + length + escaping. The additive
checksum appears specifically inside:
- **offline stroke records** — one checksum byte per stroke (§6.3), and
- **firmware-upload chunks** (`Chunk.calcChecksum(data)` in
  `ProtocolParser20.buildPenSwUploadChunk`, `:1096`) — out of scope here.

There is **no CRC32** in this protocol (contrast the G1).

---

## 5. ProtocolV2 commands & events

Opcodes are single bytes. By NeoLAB convention, **`REQ_*` (host→pen)** low codes
`0x0x–0x4x`; the matching **`RES_*` (pen→host response)** is the request code
`| 0x80` (e.g. `REQ_PenInfo 0x01` → `RES_PenInfo 0x81`). **`RES_Event*`
(unsolicited pen→host)** live in `0x60–0x6F`. All constants from `CMD20.java`.

### 5.0 Master opcode tables

**(a) Host → pen requests** (and their builders in `ProtocolParser20.java`):

| Hex  | Name (CMD20)             | Builder (`ProtocolParser20`)            | Payload (data field) |
|------|--------------------------|-----------------------------------------|----------------------|
| 0x01 | REQ_PenInfo              | `buildReqPenInfo` `:300`                | `appName(16)` `appType u16 LE(2)` `appVer(16)` `reqProtocolVer(8)` |
| 0x02 | REQ_Password             | `buildPasswordInput` `:346`             | `password ASCII(16, NUL-padded)` |
| 0x03 | REQ_PasswordSet          | `buildPasswordSetup` `:365`             | `isUse(1)` `oldPassword(16)` `newPassword(16)` |
| 0x04 | REQ_PenStatus            | `buildPenStatusData` `:383`             | *(empty)* |
| 0x05 | REQ_PenStatusChange      | (per-subtype builders, see §5.3)        | `subType(1)` + subtype payload |
| 0x06 | REQ_SetPerformance       | `buildReqSetPerformance` `:1284`        | `type=1(1)` `reserved u32(4)` `step u32(4)` |
| 0x07 | REQ_SystemInfo           | `buildReqSystemInfo` `:1276`            | *(empty)* |
| 0x11 | REQ_UsingNoteNotify      | `buildAddUsingNotes*` `:618`–`:754`     | `count u16(2)` + N×`{owner(3) section(1) noteId u32(4)}` (see §5.5) |
| 0x21 | REQ_OfflineNoteList      | `buildReqOfflineDataList(All)` `:761`/`:778` | all: `0xFFFFFFFF(4)`; filtered: `owner(3) section(1)` |
| 0x22 | REQ_OfflinePageList      | `buildReqOfflineDataPageList` `:800`    | `owner(3) section(1) noteId u32(4)` |
| 0x23 | REQ_OfflineDataRequest   | `buildReqOfflineData` `:823`/`:861`     | **§6/§7** — `deleteFlag(1)` `compress(1)` `owner(3) section(1) noteId(4) pageCount(4)` [+pageIds] |
| 0x24 | RES_OfflineChunk (ACK)*  | `buildOfflineChunkResponse` `:908`      | host→pen **ack**: see §6.2 (uses error byte) |
| 0x25 | REQ_OfflineNoteRemove ⚠  | `buildReqOfflineDataRemove` `:932`      | **DELETE** — `owner(3) section(1) noteCount(1)` + N×`noteId u32(4)` |
| 0x26 | REQ_OfflineNoteInfo      | `buildReqOfflineNoteInfo` `:1003`       | `owner(3) section(1) noteId u32(4)` |
| 0x27 | REQ_OfflinePageRemove ⚠  | `buildReqOfflineDataRemoveByPage` `:967`| **DELETE** — `owner(3) section(1) noteId(4) pageCount(1)` + N×`pageId u32(4)` |
| 0x31 | REQ_PenFWUpgrade         | `buildPenSwUpgrade` `:1030`             | firmware upgrade init (out of scope) |
| 0x41 | REQ_PenProfile           | `buildProfile*` `:1115`–`:1274`         | profile store (out of scope) |

\* The offline-chunk pair is two opcodes: `RES_OfflineChunk = 0x24` is the
**pen→host** data chunk (an *event*); `ACK_OfflineChunk = 0xA4` is the **host→pen**
ack (`CMD20.java:207`, `:211`). The ack builder `buildOfflineChunkResponse` sets cmd
`0xA4` (`ProtocolParser20.java:911`). The Web SDK names the same pair
`OFFLINE_PACKET_REQUEST = 0x24` (pen→host) / `OFFLINE_PACKET_RESPONSE = 0xA4`
(host→pen ack) (`CMD.ts:74`, `:76`). Treat **0x24 = pen sends a data chunk**,
**0xA4 = host acks a chunk**. (The `0x24` row in this table documents the host-side
ack builder; the pen→host `0x24` event is in table (b) below.)

**(b) Pen → host events / responses** (`parsePacket()` switch,
`CommProcessor20.java:606`):

| Hex  | Name (CMD20)             | Class   | Handler (`CommProcessor20.java`) | Meaning |
|------|--------------------------|---------|----------------------------------|---------|
| 0x81 | RES_PenInfo              | response| `:615`                           | identity: device name / fw / protocol / sub-name / pen type (§5.1) |
| 0x82 | RES_Password             | response| `:886`                           | auth result: status + retry/reset counts (§5.2) |
| 0x83 | RES_PasswordSet          | response| `:974`                           | password-change result |
| 0x84 | RES_PenStatus            | response| `:750`                           | settings + `isLock` + battery + storage + maxPress (§5.3) |
| 0x85 | RES_PenStatusChange      | response| `:2144`                          | ack of a setting change (echoes subType) |
| 0x91 | RES_UsingNoteNotify      | response| `:1032`                          | ack of "using note" registration |
| 0xA1 | RES_OfflineNoteList      | response| `:2255`                          | list of stored notes (§6.1) |
| 0xA2 | RES_OfflinePageList      | response| `:2309`                          | list of stored pages in a note (§6.1) |
| 0xA3 | RES_OfflineDataRequest   | response| `:2351`                          | transfer-start: strokeCount + totalDataSize + compress (§6.2) |
| 0xA5 | RES_OfflineNoteRemove    | response| `:2482`                          | delete-notes ack → fires `OFFLINE_DATA_FILE_DELETED` (§7) |
| 0xA6 | RES_OfflineNoteInfo      | response| `:2507`                          | per-note info: version, page bitmap |
| 0xA7 | RES_OfflinePageRemove    | response| `:2587`                          | delete-pages ack → fires `OFFLINE_DATA_FILE_DELETED` (§7) |
| 0x24 | RES_OfflineChunk         | event   | `:2390`                          | **one chunk of stored stroke data** (§6.2) |
| 0x61 | RES_EventBattery         | event   | `:2673`                          | unsolicited battery report |
| 0x62 | RES_EventPowerOff        | event   | `:2688`                          | pen powering off (reason byte) |
| 0x63 | RES_EventPenUpDown       | event   | `:1057`                          | combined up/down (legacy / non-separate-updown fw) |
| 0x64 | RES_EventIdChange        | event   | `:1268`                          | page-address change (legacy) |
| 0x65 | RES_EventDotData         | event   | `:1366`                          | live dot (legacy) |
| 0x66 | RES_EventDotData2        | event   | `:1485`                          | live dot variant |
| 0x67 | RES_EventDotData3        | event   | `:1600`                          | live dot variant |
| 0x69 | RES_EventPenDown         | event   | `:1720`                          | **pen-down** (separate-updown V2) (§5.4) |
| 0x6A | RES_EventPenUp           | event   | `:1806`                          | **pen-up** (separate-updown V2) (§5.4) |
| 0x6B | RES_EventIdChange2       | event   | `:1874`                          | **page-address change** (V2) (§5.4) |
| 0x6C | RES_EventDotData4        | event   | `:1940`                          | **live dot** (V2 — the canonical one) (§5.4) |
| 0x6D | RES_EventErrorDot2       | event   | `:2079`                          | error/diagnostic dot |
| 0x6F | RES_EventDotData5        | event   | `:2039`                          | hover-mode dot (no pressure) |
| 0x32 | RES_EventUploadPenFWChunk| event   | `:2666`                          | firmware-chunk request (out of scope) |

> **For an F130 (separate-updown V2)** the live-ink stream you will actually receive
> is `0x69` (down) → `0x6B` (id/page change, as needed) → repeated `0x6C` (dots) →
> `0x6A` (up). The `0x63/0x64/0x65` family is the older combined encoding; the SDK
> gates on `isSupportSeparateUpDown` (`CommProcessor20.java:638`, `:1059`). The
> `ConvertToPacket.java` `0x63/0x64/0x65` builders are **V1** and unrelated.

### 5.1 Establish / pen info (`REQ_PenInfo 0x01` → `RES_PenInfo 0x81`)

After CCCD subscription the host sends `REQ_PenInfo` (builder `:300`). The pen replies
`RES_PenInfo 0x81`; on `resultCode == 0x00` the SDK reads (offsets into the data
field, `CommProcessor20.java:630`–`:688`):

| Offset | Size | Field |
|--------|------|-------|
| 0  | 16 | device name (ASCII, trimmed) — e.g. `NWP-F130` |
| 16 | 16 | firmware version (ASCII) |
| 32 | 8  | protocol version (ASCII, e.g. `"2.xx"`) |
| 40 | 16 | sub-name (ASCII) |
| 56 | 2  | pen type (`int`) — `2` ⇒ eraser tip |
| 64 | 1  | press-sensor type |
| 65 | 4  | pen "type code" (parsed by `parsePenTypeCode`) |
| 69 | 1  | `isSupportCompress` (if protocol ≥ compress-support version) |

On success the SDK marks the connection established and immediately sends
`REQ_PenStatus 0x04` (`:725`). On a non-zero result it unbinds (the pen shuts down).

### 5.2 Password / authentication handshake

**This is the most likely real-world blocker.** The pen can be password-locked; if it
is, no offline data (or anything else) flows until the host authenticates.

**Where the gate is decided:** in `RES_PenStatus 0x84`, data byte 0 is `isLock`
(`CommProcessor20.java:755`). After processing status:
- If **`isLock == true`** and not yet authenticated → the SDK raises a
  `PASSWORD_REQUEST` event to the app carrying `retryCount`/`resetCount`
  (`:829`–`:844`). It does **not** auto-send a password; the app must supply one.
- If **`isLock == false`** → the SDK marks itself authenticated immediately
  (`onAuthorized()`), runs calibration, and sets the RTC (`:846`–`:864`). No password
  needed.

**Host sends the password** via `reqInputPassword(pw)` →
`buildPasswordInput(pw)` = `REQ_Password 0x02` with the password as **16 bytes ASCII,
NUL-padded** (`ProtocolParser20.java:346`–`:354`). Note: the SDK **refuses to send
`"0000"`** — it treats `0000` as an illegal/blank password and raises
`PEN_ILLEGAL_PASSWORD_0000` instead of transmitting (`CommProcessor20.java:3401`).
That strongly implies **`0000` is the pen's "no password / factory" sentinel** and a
real lock uses some other code. `TODO: confirm on device` what the F130's default /
user-set password actually is — the SDK ships **no** default password constant.

**Pen replies** `RES_Password 0x82`; on `resultCode == 0x00` the data is
(`:897`–`:899`):

| Offset | Size | Field |
|--------|------|-------|
| 0 | 1 | status — `0`=success, `1`=old password wrong, `2`=reset (retry == max), `3`=system error |
| 1 | 1 | retry count |
| 2 | 1 | reset count |

> **SDK quirk (verbatim from code, not a typo):** the success branch that calls
> `onAuthorized()` is guarded by **`if (status == 1)`** (`:902`–`:928`), i.e. the
> code labelled "old password wrong" is what flips the pen to authenticated. The
> `else` branch re-raises `PASSWORD_REQUEST`. This inversion looks wrong but is what
> the shipping SDK does; the most plausible reading is that the firmware's status
> codes here differ from the comment, or `status==1` is "accepted" on this command.
> **`TODO: confirm on device`** — when building Console's client, drive auth by
> *observing which branch leads to dot/offline traffic flowing*, and treat
> `resultCode != 0` (frame-level) as the real failure, not the inner `status`.

`REQ_PasswordSet 0x03` (`buildPasswordSetup`, `:365`) sets/changes/disables the
password: `isUse(1)` + `oldPassword(16)` + `newPassword(16)`. For a read-only rescue
tool you never send this.

### 5.3 Pen status + settings (`REQ_PenStatus 0x04` → `RES_PenStatus 0x84`)

`REQ_PenStatus` has an empty payload (`buildPenStatusData`, `:383`). The
`RES_PenStatus 0x84` data layout (`CommProcessor20.java:755`–`:794`):

| Offset | Size | Field |
|--------|------|-------|
| 0  | 1 | `isLock` (password lock) — the auth gate (§5.2) |
| 1  | 1 | reset count |
| 2  | 1 | retry count |
| 3  | 8 | pen RTC timestamp (ms, `long`) |
| 11 | 2 | auto-power-off time (minutes) |
| 13 | 2 | `maxPress` (max pressure; 0 ⇒ SDK uses 852) |
| 15 | 1 | used memory (storage) % |
| 16 | 1 | pencap off (model-dependent) |
| 17 | 1 | auto-power-on enabled |
| 18 | 1 | beep enabled |
| 19 | 1 | hover-mode enabled |
| 20 | 1 | **battery %** (`stat_battery`) |
| 21 | 1 | **offline-data-save enabled** (`stat_offlinedata_save`) |
| 22 | 1 | sensitivity (`255` ⇒ fixed/unsupported) |
| 43 | 1 | supports "system setting" |

Settings are changed via `REQ_PenStatusChange 0x05` with a 1-byte sub-type then the
sub-payload (`CMD20.java:117`–`:168`; builders `ProtocolParser20.java:416`–`:611`):

| SubType | Name | Builder | Payload |
|---------|------|---------|---------|
| 0x01 | CurrentTimeSet (RTC) | `buildSetCurrentTimeData` `:416` | `now ms u64(8)` |
| 0x02 | AutoShutdownTime | `buildAutoShutdownTimeSetup` `:435` | `minutes u16(2)` |
| 0x03 | PenCapOnOff | `buildPenCapOnOffSetup` `:456` | `on(1)` |
| 0x04 | AutoPowerOnSet | `buildPenAutoPowerSetup` `:474` | `on(1)` |
| 0x05 | BeepOnOff | `buildPenBeepSetup` `:492` | `on(1)` |
| 0x06 | HoverOnOff | `buildPenHoverSetup` `:509` | `on(1)` |
| 0x07 | OfflineDataSaveOnOff | `buildPenOfflineDataSaveSetup` `:526` | `on(1)` |
| 0x08 | LEDColorSet | `buildPenTipColorSetup` `:543` | `a r g b (4)` |
| 0x09 | SensitivitySet | `buildPenSensitivitySetup` `:571` | `level(1)` |
| 0x0D | SensitivitySet_FSC | `buildPenSensitivitySetupFSC` `:588` | `level(1)` |
| 0x11 | Disk_Reset ⚠ | `buildPenDiskReset` `:603` | magic `0x4F1C0B42 (4)` — **wipes pen storage**; never send for rescue |
| 0x16 | Camera_Register | `buildSetCameraRegister` `:392` | register pairs |

> **RTC matters for rescue.** Offline strokes are timestamped against the pen's RTC
> (§6.3). For a pure read you do not *need* to set the RTC, and setting it
> (`CurrentTimeSet`) does not erase anything — but be aware the SDK normally sets RTC
> as part of authorize. `REQ_PenStatusChange_TYPE_Disk_Reset (0x11)` is a destructive
> full-storage wipe — **do not send it.**

### 5.4 Live dot stream (V2, separate up/down)

The genuine V2 live-ink events (an F130 with separate-updown firmware emits these):

**`RES_EventPenDown 0x69`** (`CommProcessor20.java:1720`):

| Offset | Size | Field |
|--------|------|-------|
| 0  | 1 | event counter (sequence; `checkEventCount` detects gaps) |
| 1  | 8 | pen-down timestamp (ms, `long`) |
| 9  | 1 | pen tip type |
| 10 | 4 | color (`a r g b`) |

**`RES_EventPenUp 0x6A`** (`:1806`):

| Offset | Size | Field |
|--------|------|-------|
| 0  | 1 | event counter |
| 1  | 8 | pen-up timestamp (ms) |
| 9  | 2 | dot count |
| 11 | 2 | total image count |
| 13 | 2 | processed image count |
| 15 | 2 | success image count |
| 17 | 2 | sent image count |

**`RES_EventIdChange2 0x6B`** — page (Ncode address) change (`:1874`):

| Offset | Size | Field |
|--------|------|-------|
| 0 | 1 | event counter |
| 1 | 3 | owner id (3 bytes) |
| 4 | 1 | section id |
| 5 | 4 | note id (u32) |
| 9 | 4 | page id (u32) |

(Section/owner are packed as `owner(3) + section(1)`; the SDK reads
`section = rxb[3] & 0xFF`, `owner = bytes[0..2]` — `:1896`–`:1900`.)

**`RES_EventDotData4 0x6C`** — the canonical live dot (`:1940`–`:1956`):

| Offset | Size | Field | Notes |
|--------|------|-------|-------|
| 0  | 1 | event counter | |
| 1  | 1 | `TIME` | delta added to the previous dot's timestamp (`timeLong = prevDotTime + TIME`) |
| 2  | 2 | `FORCE` (pressure) | scaled to 0–255 by `pressure*255/maxPress` downstream |
| 4  | 2 | `X` (short) | integer part of x |
| 6  | 2 | `Y` (short) | integer part of y |
| 8  | 1 | `FLOAT_X` (fx) | 0–99, fractional part |
| 9  | 1 | `FLOAT_Y` (fy) | 0–99, fractional part |
| 10 | 1 | `TILT_X` | |
| 11 | 1 | `TILT_Y` | |
| 12 | 2 | `twist` (short) | |

**Coordinate reconstruction** (`Dot.java:216`–`:218`):
`x = X + fx*0.01`, `y = Y + fy*0.01` (both floats). The page address (section/owner/
note/page) comes from the most recent `0x6B`. The dot's **type** is assigned by the
state machine, not carried in the packet: first dot after down ⇒ `PEN_ACTION_DOWN`,
subsequent ⇒ `PEN_ACTION_MOVE`, and on `0x6A`/`0x6B` the previous dot is re-emitted as
`PEN_ACTION_UP` (`:2002`–`:2008`, `:1835`–`:1848`).

**`RES_EventDotData5 0x6F`** — hover dot, no pressure (`:2039`–`:2051`):
`TIME(1) X(2) Y(2) FLOAT_X(1) FLOAT_Y(1)`.

**Dot types** (`DotType.java`): `PEN_ACTION_DOWN = 17`, `PEN_ACTION_MOVE = 18`,
`PEN_ACTION_UP = 20`, `PEN_ACTION_HOVER = 25`. (`Dot.makeDownDot` sets 17,
`Dot.makeUpDot` sets 20 — `Dot.java:401`,`:414`.)

### 5.5 "Using note" registration (`REQ_UsingNoteNotify 0x11`)

Tells the pen which notebooks the app cares about (so the pen streams/saves only
those). `count u16(2)` then N × `{owner(3) section(1) noteId u32(4)}`
(`buildAddUsingNotes`, `:618`–`:754`). `count = 0xFFFF` = "all notes"
(`buildAddUsingAllNotes`, `:747`). A note entry of `noteId = 0xFFFFFFFF` means "all
notes in that section/owner". Not needed for offline rescue (you enumerate stored
data directly via §6.1).

---

## 6. Offline data — stored-stroke transfer protocol

The pen stores strokes to flash when it's away from a phone (gated by the
"offline-data-save" setting, §5.3 byte 21). Pulling them is a four-phase flow:
**enumerate notes → enumerate pages → request data → receive+ack chunks**.

### 6.1 Enumeration

- **List notes:** `REQ_OfflineNoteList 0x21`.
  - all: `buildReqOfflineDataListAll` → payload `0xFFFFFFFF` (`:761`).
  - filtered to a section/owner: `buildReqOfflineDataList` → `owner(3) section(1)`
    (`:778`).
  - Reply `RES_OfflineNoteList 0xA1` (`:2255`): `count u16(2)` then N × 8-byte
    records `{owner(3) section(1) noteId u32(4)}`. If the pen supports count-limiting
    and returns exactly 64, the SDK re-requests for the next page of the list
    (`:2278`–`:2290`).
- **List pages in a note:** `REQ_OfflinePageList 0x22` →
  `buildReqOfflineDataPageList` = `owner(3) section(1) noteId(4)` (`:800`).
  - Reply `RES_OfflinePageList 0xA2` (`:2309`): header
    `owner(3) section(1) noteId(4) count u16(2)` then N × `pageId u32(4)`.
    Re-requests when count hits 128.
- **Per-note info (v2.16+):** `REQ_OfflineNoteInfo 0x26` → reply `0xA6` carries
  note version + a **page bitmap** (`:2507`–`:2578`) — a compact way to learn which
  pages exist without the full page list.

### 6.2 Requesting + receiving data (`REQ_OfflineDataRequest 0x23`)

`buildReqOfflineData` (`:823` whole-note, `:861` with explicit page list). **Data
field layout** (14 bytes + 4×pageCount):

| Offset | Size | Field | Value |
|--------|------|-------|-------|
| 0 | 1 | **delete-after-transfer flag** | `1` or `2` — **see §7** |
| 1 | 1 | compress | `1` = zlib-compressed (recommended), `0` = raw |
| 2 | 3 | owner id | |
| 5 | 1 | section id | |
| 6 | 4 | note id (u32) | |
| 10 | 4 | page count (u32) | `0` ⇒ all pages in the note |
| 14 | 4×N | page ids | only if page count > 0 |

The pen replies **`RES_OfflineDataRequest 0xA3`** (transfer header,
`CommProcessor20.java:2351`–`:2374`): `strokeCount u32(0,4)`,
`totalDataSize u32(4,4)`, `isCompressed(8,1)`. `totalDataSize == 0` ⇒ nothing to send
(`OFFLINE_DATA_SEND_FAILURE`).

Then the pen streams **`RES_OfflineChunk 0x24`** events (`:2390`–`:2456`). Each chunk
header (data-field offsets):

| Offset | Size | Field |
|--------|------|-------|
| 0 | 2 | packet id |
| 3 | 2 | size-before-compress |
| 5 | 2 | size-after-compress |
| 7 | 1 | **position** — `0`=start, `1`=middle, `2`=end |
| 8 | 4 | owner(3)+section(1) |
| 12 | 4 | note id |
| 16 | 2 | stroke count in this chunk |
| 18 | … | stroke payload (zlib-deflated if compressed) |

(Offsets per the Web SDK `ResOfflineData`, `PenClientParserV2.ts:839`–`:850`, which
agrees with the Android `OfflineByteParser` header read.)

**Per-chunk ACK — `0xA4` (host→pen).** After each chunk the host sends
`buildOfflineChunkResponse(errorCode, packetId, position)`
(`ProtocolParser20.java:908`): a frame with cmd `0xA4`, **error byte = errorCode**,
length `3`, then `packetId u16(2)` and a 1-byte **continue flag**: `position == 2`
⇒ `0` (stop), else `1` (keep going) (`:913`–`:918`).

> **Subtle difference between the two SDKs on the final chunk:**
> - **Android** sends an ack for **every** chunk including the `position == 2`
>   terminal one (`CommProcessor20.java:2434`, unconditional after parsing).
> - **Web SDK** sends `ReqOfflineData2` (the ack) **only when `transPosition !== 2`**
>   — it does **not** ack the final chunk (`PenClientParserV2.ts:881`–`:888`).
>
> So the "is the terminal chunk acked?" behaviour is **ambiguous across NeoLAB's own
> implementations**. This is directly relevant to erase semantics (§7) when the
> delete flag is set — `TODO: confirm on device` whether the pen requires the final
> ack to consider a delete-on-finish transfer "complete".

When `position == 2`, the Android SDK assembles all accumulated strokes into an
`OfflineByteData` and fires `onCreateOfflineStrokes` (`:2419`–`:2428`). A failure
watchdog (`mChkOfflineFailRunnable`, 20 s — `OFFLINE_SEND_FAIL_TIME` at
`CommProcessor20.java:160`) is armed between non-terminal chunks and disarmed on the
terminal one.

### 6.3 Stored byte format (inside the chunk payload)

Decompress first if `isCompressed` (raw zlib/`InflaterInputStream` —
`OfflineByteParser.java:327`). The decompressed body is a sequence of **strokes**,
each = a **27-byte stroke header** + N × **16-byte dot records**
(`OfflineByteParser.java:46`–`:47`: `STROKE_HEADER_LENGTH = 27`,
`BYTE_DOT_SIZE = 16`; parse loop `:167`–`:300`).

**Stroke header (27 bytes)** (`:169`–`:184`):

| Offset | Size | Field |
|--------|------|-------|
| 0  | 4 | page id (u32) |
| 4  | 8 | pen-down time (ms, `long`) |
| 12 | 8 | pen-up time (ms, `long`) |
| 20 | 1 | pen tip type |
| 21 | 4 | color (`a r g b`) |
| 25 | 2 | dot count |

(The section/owner/note for every stroke come from the chunk/transfer header, not the
stroke header — `:147`–`:151`.)

**Dot record (16 bytes)** (`:203`–`:219`):

| Offset | Size | Field |
|--------|------|-------|
| 0  | 1 | time delta (ms, added to running timestamp) |
| 1  | 2 | pressure |
| 3  | 2 | X (short) |
| 5  | 2 | Y (short) |
| 7  | 1 | fx (0–99) |
| 8  | 1 | fy (0–99) |
| 9  | 1 | tilt X |
| 10 | 1 | tilt Y |
| 11 | 2 | twist (short) |
| 13 | 2 | *(reserved / unused by parser)* |
| 15 | 1 | **per-stroke checksum** (only meaningful on the last dot) |

Coordinate reconstruction is the same `X + fx*0.01`, `Y + fy*0.01` as live dots
(`:258`–`:268`). Dot type within a stroke is positional: first dot ⇒ `PEN_ACTION_DOWN`
(timestamp = penDownTime + time), last ⇒ `PEN_ACTION_UP` (timestamp = penUpTime),
middle ⇒ `PEN_ACTION_MOVE` (`:226`–`:244`). A single-dot stroke is expanded to
down+move+up (`:257`–`:266`).

**Checksum:** byte 15 of the **last** dot of a stroke is the 8-bit additive checksum
over that last dot record's first 15 bytes
(`Chunk.calcChecksum(copyOfRange(data, strokeIndex+dotIndex-16, 15))` —
`OfflineByteParser.java:279`). The parser tolerates up to 3 stroke checksum failures
before throwing `CheckSumException` (`:301`). Pressures > 852 are discarded as
invalid (`:272`–`:273`).

---

## 7. ★ Offline erase semantics ★ (CRITICAL)

**Question:** does pulling offline data cause the pen to delete it from flash?

**Verdict: BOTH a deliberate flag AND separate explicit commands exist — and the
SDK's *default* is to delete. There is no evidence of an unconditional auto-erase that
fires regardless of the host's choice.** Concretely:

### (a) A deliberate delete-on-transfer flag — byte 0 of `REQ_OfflineDataRequest 0x23`

The first data byte of the offline-data request controls post-transfer deletion. From
`buildReqOfflineData` (both overloads), the byte is written as
**`deleteOnFinished ? 1 : 2`**:

```java
// ProtocolParser20.java:830-834  (and identically :873-877)
// isOffline data remove after transfer
// 0: not send req2
// 1: send req2(after res1), remove offline data
// 2: send req2(after res1), not remove offline data
sendbyte.write( (byte) (deleteOnFinished ? 1 : 2) );
```

So the **pen** decides whether to erase based on this flag:
- `1` ⇒ after the transfer the pen **removes** the offline data.
- `2` ⇒ after the transfer the pen **keeps** it.
- (`0` is documented in the comment as "don't send the follow-up req2" — the builder
  never emits `0`.)

The Web SDK is byte-for-byte identical: `bf.Put(deleteOnFinished ? 1 : 2)`
(`PenRequestV2.ts:461`), default `deleteOnFinished = true`
(`PenRequestV2.ts:454`, `PenController.ts:331`).

> **⚠ The dangerous part: the SDK's convenience defaults are DELETE.** The
> public Android helpers default `deleteOnFinished = true`:
> ```java
> // CommProcessor20.java:3249-3251
> public void reqOfflineData(int sectionId, int ownerId, int noteId) {
>     reqOfflineData(sectionId, ownerId, noteId, true);   // delete!
> }
> ```
> Same for the page-list overload (`:3267`–`:3269`) and the `extra`-carrying
> overloads (`:3287`–`:3296`, hardcoded `true`). Only the explicit-flag overloads
> (`:3254`, `:3281`) let you pass `false`. **For Console's rescue tool we must always
> build the `0x23` request ourselves with byte 0 = `2` (keep).** Do not call any
> convenience wrapper.

### (b) Separate, explicit delete commands — `0x25` and `0x27`

Independently of the transfer, the host can erase stored data with dedicated commands.
These are **only ever sent from the public `reqOfflineDataRemove*` methods** — never
auto-invoked by the receive path:

- **`REQ_OfflineNoteRemove 0x25`** — delete whole notes. Builder
  `buildReqOfflineDataRemove` (`ProtocolParser20.java:932`): `owner(3) section(1)
  noteCount(1)` + N × `noteId u32(4)`. Sent only by
  `CommProcessor20.reqOfflineDataRemove` (`:3339`–`:3342`). Pen acks
  `RES_OfflineNoteRemove 0xA5` (`:2482`), which fires `OFFLINE_DATA_FILE_DELETED`.
- **`REQ_OfflinePageRemove 0x27`** — delete specific pages. Builder
  `buildReqOfflineDataRemoveByPage` (`:967`): `owner(3) section(1) noteId(4)
  pageCount(1)` + N × `pageId u32(4)`. Sent only by `reqOfflineDataRemoveByPage`
  (`:3353`–`:3355`). Ack `RES_OfflinePageRemove 0xA7` (`:2587`).

Web SDK mirror: `ReqOfflineDelete` builds `OFFLINE_DATA_DELETE_REQUEST = 0x25`
(`PenRequestV2.ts`/`CMD.ts:79`).

### Is there an unconditional auto-erase after a transfer completes?

**No evidence of one.** Searching `CommProcessor20.java`, `buildReqOfflineDataRemove`
/ `reqOfflineDataRemove` appear **only** in the public delete methods (`:3339`,
`:3353`) — they are **never** called from the chunk-receive handler
(`RES_OfflineChunk` at `:2390`), from the `position == 2` terminal branch (`:2419`),
or from `onCreateOfflineStrokes`. The terminal-chunk path assembles strokes and acks;
it does not issue any remove command. So **the only erase that happens as part of a
transfer is the one the pen performs because the host set byte 0 = `1`.**

### Net guidance for the rescue tool

1. **Never** send `REQ_OfflineNoteRemove (0x25)` or `REQ_OfflinePageRemove (0x27)`.
2. **Always** build `REQ_OfflineDataRequest (0x23)` by hand with **byte 0 = `2`**
   (keep-after-transfer). Do **not** use any `reqOfflineData(...)` convenience
   overload — they default to delete.
3. **Never** send `REQ_PenStatusChange / Disk_Reset (0x05/0x11)` — that's a full
   storage wipe (§5.3).
4. The erase, when it happens, is the **pen's** action triggered by the `0x23` flag —
   it is *category (a)*, a deliberate flag, **not** an auto-erase-on-ack that you'd
   have to dodge by mishandling the ack flow. So "send byte 0 = 2" is sufficient to
   preserve data. **However**, because NeoLAB's two SDKs disagree on whether the
   *terminal chunk is acked* (§6.2), and the delete is described as happening "after
   res1 / on the follow-up req2", there is residual uncertainty about the exact moment
   and trigger of the pen-side delete when the flag IS set. Since we will set the flag
   to **keep**, this uncertainty does not endanger data — but **`TODO: confirm on
   device`**: with byte 0 = `2`, verify (e.g. by re-listing notes after a full
   transfer) that the data genuinely remains on flash.

---

## 8. Scope note

- Covers **NWP-F130 / Moleskine Pen+ / N2 family / ProtocolV2 only**. ProtocolV1 pens
  (`CommProcessor`, `ConvertToPacket` `0x63/0x64/0x65` dot codes) are explicitly out
  of scope and use a different command processor.
- Derived **entirely from reading NeoLAB's open-source SDKs** (Android Java primary,
  Web TypeScript cross-check). **No on-device capture has been performed.** Every
  `TODO: confirm on device` marks an inference to validate against a real F130 before
  relying on it — especially: the advertised local name, the actual password/lock
  behaviour and any default code, the `RES_Password status==1` quirk, and the
  keep-after-transfer (byte 0 = 2) preservation guarantee.
- Firmware upgrade (`0x31`/`0xB1`/`0x32`), pen profiles (`0x41`/`0xC1`),
  camera-register and performance/eco-mode tuning are listed for completeness but not
  detailed — none are needed (or safe) for a read-only data-rescue use case.
- The intended Console feature is **non-destructive offline-stroke extraction**; the
  load-bearing rule is §7: keep-after-transfer (byte 0 = 2), never send a remove or
  disk-reset command.
