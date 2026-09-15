export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    /* =====================================================
       JSON RESPONSE
       ===================================================== */

    const json = (data, status = 200) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      });
    };

    /* =====================================================
       CORS
       ===================================================== */

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      });
    }

    /* =====================================================
       CONFIG
       ===================================================== */

    const SUPABASE_URL = env.supabase_url;
    const SUPABASE_KEY = env.cloudflare_worker;

    const BUCKET = "verona-media";

    const NOTES_KEY = "verona:notes";
    const PUSH_KEY = "verona:push:subscriptions";

    const VAPID_PUBLIC_KEY =
      "BNdDq6ByHa_59pD0D99zJIf9bZcbAnGbr8Kr37d2XrxbcByw3HSwfE1xFo1FFQ0wZ1HH07mXlgXowddrkNVQOxo";

    const VAPID_PRIVATE_KEY =
      env.VAPID_PRIVATE_KEY || "";

    const VAPID_SUBJECT =
      env.VAPID_SUBJECT ||
      "mailto:veronastone@example.com";

    /* =====================================================
       KV - NOTES
       ===================================================== */

    async function getNotes() {
      try {
        if (!env.VERONA_NOTES) {
          return [];
        }

        const value = await env.VERONA_NOTES.get(
          NOTES_KEY,
          "json"
        );

        return Array.isArray(value) ? value : [];
      } catch (error) {
        console.error("getNotes:", error);
        return [];
      }
    }

    async function saveNotes(notes) {
      if (!env.VERONA_NOTES) {
        throw new Error(
          "VERONA_NOTES KV binding is missing."
        );
      }

      await env.VERONA_NOTES.put(
        NOTES_KEY,
        JSON.stringify(notes)
      );
    }

    /* =====================================================
       KV - PUSH SUBSCRIPTIONS
       ===================================================== */

    async function getPushSubscriptions() {
      try {
        if (!env.VERONA_NOTES) {
          return [];
        }

        const value = await env.VERONA_NOTES.get(
          PUSH_KEY,
          "json"
        );

        return Array.isArray(value) ? value : [];
      } catch (error) {
        console.error(
          "getPushSubscriptions:",
          error
        );

        return [];
      }
    }

    async function savePushSubscriptions(subscriptions) {
      if (!env.VERONA_NOTES) {
        throw new Error(
          "VERONA_NOTES KV binding is missing."
        );
      }

      await env.VERONA_NOTES.put(
        PUSH_KEY,
        JSON.stringify(subscriptions)
      );
    }

    /* =====================================================
       BASE64URL
       ===================================================== */

    function base64UrlToUint8Array(value) {
      const padding =
        "=".repeat(
          (4 - (value.length % 4)) % 4
        );

      const base64 =
        (value + padding)
          .replace(/-/g, "+")
          .replace(/_/g, "/");

      const binary = atob(base64);

      const bytes =
        new Uint8Array(binary.length);

      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      return bytes;
    }

    function uint8ArrayToBase64Url(bytes) {
      let binary = "";

      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }

      return btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
    }

    function concatBytes(...arrays) {
      const total = arrays.reduce(
        (sum, arr) => sum + arr.length,
        0
      );

      const result =
        new Uint8Array(total);

      let offset = 0;

      for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
      }

      return result;
    }

    /* =====================================================
       HMAC / HKDF
       ===================================================== */

    async function hmac(keyBytes, dataBytes) {
      const key =
        await crypto.subtle.importKey(
          "raw",
          keyBytes,
          {
            name: "HMAC",
            hash: "SHA-256"
          },
          false,
          ["sign"]
        );

      return new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          key,
          dataBytes
        )
      );
    }

    async function hkdfExtract(salt, ikm) {
      return hmac(salt, ikm);
    }

    async function hkdfExpand(
      prk,
      info,
      length
    ) {
      const blocks = [];

      let previous =
        new Uint8Array(0);

      let counter = 1;

      let produced = 0;

      while (produced < length) {
        const input = concatBytes(
          previous,
          info,
          new Uint8Array([counter])
        );

        previous =
          await hmac(
            prk,
            input
          );

        blocks.push(previous);

        produced +=
          previous.length;

        counter++;

        if (counter > 255) {
          throw new Error(
            "HKDF output too large."
          );
        }
      }

      return concatBytes(
        ...blocks
      ).slice(0, length);
    }

    /* =====================================================
       WEB PUSH ENCRYPTION
       ===================================================== */

    async function encryptPushPayload(
      subscription,
      payloadText
    ) {
      if (!subscription?.keys) {
        throw new Error(
          "Push subscription keys are missing."
        );
      }

      const clientPublicKey =
        base64UrlToUint8Array(
          subscription.keys.p256dh
        );

      const authSecret =
        base64UrlToUint8Array(
          subscription.keys.auth
        );

      if (
        clientPublicKey.length !== 65
      ) {
        throw new Error(
          "Invalid p256dh key."
        );
      }

      /* ---------------------------------------------
         Generate server ephemeral key pair
         --------------------------------------------- */

      const serverKeyPair =
        await crypto.subtle.generateKey(
          {
            name: "ECDH",
            namedCurve: "P-256"
          },
          true,
          ["deriveBits"]
        );

      const serverPublicKey =
        new Uint8Array(
          await crypto.subtle.exportKey(
            "raw",
            serverKeyPair.publicKey
          )
        );

      /* ---------------------------------------------
         Import browser public key
         --------------------------------------------- */

      const clientKey =
        await crypto.subtle.importKey(
          "raw",
          clientPublicKey,
          {
            name: "ECDH",
            namedCurve: "P-256"
          },
          false,
          []
        );

      /* ---------------------------------------------
         ECDH
         --------------------------------------------- */

      const sharedSecret =
        new Uint8Array(
          await crypto.subtle.deriveBits(
            {
              name: "ECDH",
              public: clientKey
            },
            serverKeyPair.privateKey,
            256
          )
        );

      /* ---------------------------------------------
         Web Push info
         --------------------------------------------- */

      const webPushInfo =
        concatBytes(
          new TextEncoder().encode(
            "WebPush: info\0"
          ),
          clientPublicKey,
          serverPublicKey
        );

      /* ---------------------------------------------
         Auth secret
         --------------------------------------------- */

      const authPrk =
        await hkdfExtract(
          authSecret,
          sharedSecret
        );

      const ikm =
        await hkdfExpand(
          authPrk,
          webPushInfo,
          32
        );

      /* ---------------------------------------------
         Random salt
         --------------------------------------------- */

      const salt =
        crypto.getRandomValues(
          new Uint8Array(16)
        );

      /* ---------------------------------------------
         Content encryption key
         --------------------------------------------- */

      const prk =
        await hkdfExtract(
          salt,
          ikm
        );

      const cek =
        await hkdfExpand(
          prk,
          new TextEncoder().encode(
            "Content-Encoding: aes128gcm\0"
          ),
          16
        );

      /* ---------------------------------------------
         Nonce
         --------------------------------------------- */

      const nonce =
        await hkdfExpand(
          prk,
          new TextEncoder().encode(
            "Content-Encoding: nonce\0"
          ),
          12
        );

      /* ---------------------------------------------
         Plaintext
         --------------------------------------------- */

      const plaintext =
        new TextEncoder().encode(
          payloadText
        );

      /*
        Final record delimiter.
      */

      const paddedPlaintext =
        concatBytes(
          plaintext,
          new Uint8Array([2])
        );

      /* ---------------------------------------------
         AES-GCM
         --------------------------------------------- */

      const aesKey =
        await crypto.subtle.importKey(
          "raw",
          cek,
          {
            name: "AES-GCM"
          },
          false,
          ["encrypt"]
        );

      const ciphertext =
        new Uint8Array(
          await crypto.subtle.encrypt(
            {
              name: "AES-GCM",
              iv: nonce,
              tagLength: 128
            },
            aesKey,
            paddedPlaintext
          )
        );

      /* ---------------------------------------------
         aes128gcm body
         --------------------------------------------- */

      const recordSize =
        new Uint8Array(4);

      new DataView(
        recordSize.buffer
      ).setUint32(
        0,
        4096
      );

      const body =
        concatBytes(
          salt,
          recordSize,
          new Uint8Array([
            serverPublicKey.length
          ]),
          serverPublicKey,
          ciphertext
        );

      return {
        body,
        contentEncoding:
          "aes128gcm"
      };
    }

    /* =====================================================
       VAPID JWT
       ===================================================== */

    async function createVapidToken(
      audience
    ) {
      if (!VAPID_PRIVATE_KEY) {
        throw new Error(
          "VAPID_PRIVATE_KEY secret is not configured."
        );
      }

      const publicKeyBytes =
        base64UrlToUint8Array(
          VAPID_PUBLIC_KEY
        );

      if (
        publicKeyBytes.length !== 65 ||
        publicKeyBytes[0] !== 4
      ) {
        throw new Error(
          "Invalid VAPID public key."
        );
      }

      const x =
        uint8ArrayToBase64Url(
          publicKeyBytes.slice(
            1,
            33
          )
        );

      const y =
        uint8ArrayToBase64Url(
          publicKeyBytes.slice(
            33,
            65
          )
        );

      const privateKey =
        await crypto.subtle.importKey(
          "jwk",
          {
            kty: "EC",
            crv: "P-256",
            x,
            y,
            d: VAPID_PRIVATE_KEY,
            ext: true
          },
          {
            name: "ECDSA",
            namedCurve: "P-256"
          },
          false,
          ["sign"]
        );

      const header = {
        typ: "JWT",
        alg: "ES256"
      };

      const now =
        Math.floor(
          Date.now() / 1000
        );

      const payload = {
        aud: audience,
        exp:
          now +
          12 * 60 * 60,
        sub: VAPID_SUBJECT
      };

      const encoder =
        new TextEncoder();

      const encodedHeader =
        uint8ArrayToBase64Url(
          encoder.encode(
            JSON.stringify(
              header
            )
          )
        );

      const encodedPayload =
        uint8ArrayToBase64Url(
          encoder.encode(
            JSON.stringify(
              payload
            )
          )
        );

      const signingInput =
        `${encodedHeader}.${encodedPayload}`;

      const signature =
        new Uint8Array(
          await crypto.subtle.sign(
            {
              name: "ECDSA",
              hash: "SHA-256"
            },
            privateKey,
            encoder.encode(
              signingInput
            )
          )
        );

      /*
        ES256 JWT signature:
        r || s
      */

      if (signature.length !== 64) {
        throw new Error(
          "Invalid ECDSA signature length."
        );
      }

      const encodedSignature =
        uint8ArrayToBase64Url(
          signature
        );

      return (
        `${signingInput}.${encodedSignature}`
      );
    }

    /* =====================================================
       SEND PUSH
       ===================================================== */

    async function sendPush(
      subscription,
      payload
    ) {
      const endpoint =
        String(
          subscription.endpoint || ""
        ).trim();

      if (!endpoint) {
        throw new Error(
          "Push endpoint is missing."
        );
      }

      const endpointUrl =
        new URL(endpoint);

      const audience =
        endpointUrl.origin;

      const token =
        await createVapidToken(
          audience
        );

      const encrypted =
        await encryptPushPayload(
          subscription,
          JSON.stringify(
            payload
          )
        );

      const response =
        await fetch(
          endpoint,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/octet-stream",

              "Content-Encoding":
                encrypted.contentEncoding,

              "TTL":
                "86400",

              "Authorization":
                `vapid t=${token}, k=${VAPID_PUBLIC_KEY}`
            },

            body:
              encrypted.body
          }
        );

      return response;
    }

    /* =====================================================
       BROADCAST PUSH
       ===================================================== */

    async function broadcastPush(
      payload
    ) {
      try {
        if (!VAPID_PRIVATE_KEY) {
          console.warn(
            "VAPID_PRIVATE_KEY missing."
          );

          return {
            success: false,
            sent: 0,
            failed: 0,
            skipped: true
          };
        }

        const subscriptions =
          await getPushSubscriptions();

        if (
          subscriptions.length === 0
        ) {
          return {
            success: true,
            sent: 0,
            failed: 0
          };
        }

        const validSubscriptions =
          [];

        let sent = 0;
        let failed = 0;

        for (
          const subscription
          of subscriptions
        ) {
          try {
            const response =
              await sendPush(
                subscription,
                payload
              );

            if (
              response.ok ||
              response.status === 201 ||
              response.status === 202
            ) {
              sent++;

              validSubscriptions.push(
                subscription
              );

              continue;
            }

            /*
              Expired subscriptions.
            */

            if (
              response.status === 404 ||
              response.status === 410
            ) {
              failed++;
              continue;
            }

            failed++;

            validSubscriptions.push(
              subscription
            );

            console.error(
              "Push failed:",
              response.status,
              await response.text()
            );
          } catch (error) {
            failed++;

            /*
              Keep subscription on temporary errors.
            */

            validSubscriptions.push(
              subscription
            );

            console.error(
              "Push error:",
              error
            );
          }
        }

        await savePushSubscriptions(
          validSubscriptions
        );

        return {
          success: true,
          sent,
          failed
        };
      } catch (error) {
        console.error(
          "broadcastPush:",
          error
        );

        return {
          success: false,
          sent: 0,
          failed: 0,
          error:
            error?.message ||
            "Push error"
        };
      }
    }

    /* =====================================================
       SUPABASE STORAGE
       ===================================================== */

    function supabaseStorageUrl(
      key
    ) {
      return (
        `${SUPABASE_URL}` +
        `/storage/v1/object/public/` +
        `${BUCKET}/${key}`
      );
    }

    async function uploadMedia(
      key,
      base64,
      contentType
    ) {
      if (
        !SUPABASE_URL ||
        !SUPABASE_KEY
      ) {
        throw new Error(
          "Supabase environment variables are not configured."
        );
      }

      const binary =
        Uint8Array.from(
          atob(base64),
          char =>
            char.charCodeAt(0)
        );

      const response =
        await fetch(
          `${SUPABASE_URL}` +
          `/storage/v1/object/` +
          `${BUCKET}/${key}`,
          {
            method: "POST",

            headers: {
              "Authorization":
                `Bearer ${SUPABASE_KEY}`,

              "apikey":
                SUPABASE_KEY,

              "Content-Type":
                contentType,

              "x-upsert":
                "true"
            },

            body:
              binary
          }
        );

      if (!response.ok) {
        const errorText =
          await response.text();

        throw new Error(
          `Supabase upload failed: ${errorText}`
        );
      }

      return supabaseStorageUrl(
        key
      );
    }

    async function deleteMedia(
      key
    ) {
      if (!key) return;

      try {
        if (
          !SUPABASE_URL ||
          !SUPABASE_KEY
        ) {
          return;
        }

        await fetch(
          `${SUPABASE_URL}` +
          `/storage/v1/object/` +
          `${BUCKET}`,
          {
            method: "DELETE",

            headers: {
              "Authorization":
                `Bearer ${SUPABASE_KEY}`,

              "apikey":
                SUPABASE_KEY,

              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify({
                prefixes: [key]
              })
          }
        );
      } catch (error) {
        console.error(
          "deleteMedia:",
          error
        );
      }
    }

    /* =====================================================
       API: GET NOTES
       ===================================================== */

    if (
      path === "/api/notes" &&
      request.method === "GET"
    ) {
      const notes =
        await getNotes();

      return json({
        success: true,
        notes
      });
    }

    /* =====================================================
       API: CREATE NOTE
       ===================================================== */

    if (
      path === "/api/notes" &&
      request.method === "POST"
    ) {
      try {
        const body =
          await request.json();

        const text =
          String(
            body.text || ""
          ).trim();

        const image =
          body.image || null;

        const voice =
          body.voice || null;

        if (
          !text &&
          !image &&
          !voice
        ) {
          return json(
            {
              success: false,
              error:
                "یادداشت خالی است."
            },
            400
          );
        }

        const notes =
          await getNotes();

        const id =
          Date.now()
            .toString(36) +
          "-" +
          Math.random()
            .toString(36)
            .slice(2, 10);

        const createdAt =
          Date.now();

        const note = {
          id,
          text,
          createdAt,
          image: null,
          voice: null
        };

        /* ---------------------------------------------
           IMAGE
           --------------------------------------------- */

        if (
          image &&
          image.data
        ) {
          const imageKey =
            `notes/${id}/image.jpg`;

          const imageUrl =
            await uploadMedia(
              imageKey,
              image.data,
              image.type ||
                "image/jpeg"
            );

          note.image = {
            url: imageUrl,
            key: imageKey
          };
        }

        /* ---------------------------------------------
           VOICE
           --------------------------------------------- */

        if (
          voice &&
          voice.data
        ) {
          const voiceKey =
            `notes/${id}/voice.webm`;

          const voiceUrl =
            await uploadMedia(
              voiceKey,
              voice.data,
              voice.type ||
                "audio/webm"
            );

          note.voice = {
            url: voiceUrl,
            key: voiceKey
          };
        }

        notes.unshift(
          note
        );

        await saveNotes(
          notes.slice(
            0,
            1000
          )
        );

        /* ---------------------------------------------
           PUSH NOTIFICATION
           --------------------------------------------- */

        const pushPayload = {
          title:
            "📝 یادداشت جدید فروشگاه ورونا",

          body:
            text ||
            "یک یادداشت جدید در فروشگاه ورونا ثبت شد.",

          url: "/"
        };

        /*
          Push is deliberately run in the background
          so the user does not have to wait for the
          notification provider.
        */

        if (
          env.VERONA_NOTES &&
          VAPID_PRIVATE_KEY
        ) {
          ctx.waitUntil(
            broadcastPush(
              pushPayload
            )
          );
        }

        return json({
          success: true,
          note
        });
      } catch (error) {
        console.error(
          "Create note:",
          error
        );

        return json(
          {
            success: false,
            error:
              error?.message ||
              "خطا در ثبت یادداشت"
          },
          500
        );
      }
    }

    /* =====================================================
       API: DELETE NOTE
       ===================================================== */

    if (
      path.startsWith(
        "/api/notes/"
      ) &&
      request.method === "DELETE"
    ) {
      const auth =
        request.headers.get(
          "Authorization"
        ) || "";

      if (
        auth !==
        "Bearer 4450"
      ) {
        return json(
          {
            success: false,
            error:
              "دسترسی غیرمجاز"
          },
          401
        );
      }

      const id =
        decodeURIComponent(
          path.replace(
            "/api/notes/",
            ""
          )
        );

      if (!id) {
        return json(
          {
            success: false,
            error:
              "شناسه یادداشت نامعتبر است."
          },
          400
        );
      }

      const notes =
        await getNotes();

      const note =
        notes.find(
          item =>
            String(item.id) ===
            String(id)
        );

      if (!note) {
        return json(
          {
            success: false,
            error:
              "یادداشت پیدا نشد."
          },
          404
        );
      }

      if (
        note.image?.key
      ) {
        await deleteMedia(
          note.image.key
        );
      }

      if (
        note.voice?.key
      ) {
        await deleteMedia(
          note.voice.key
        );
      }

      const remaining =
        notes.filter(
          item =>
            String(item.id) !==
            String(id)
        );

      await saveNotes(
        remaining
      );

      return json({
        success: true
      });
    }

    /* =====================================================
       API: VAPID PUBLIC KEY
       ===================================================== */

    if (
      path ===
        "/api/push/public-key" &&
      request.method === "GET"
    ) {
      return json({
        success: true,
        publicKey:
          VAPID_PUBLIC_KEY
      });
    }

    /* =====================================================
       API: SUBSCRIBE PUSH
       ===================================================== */

    if (
      path ===
        "/api/push/subscribe" &&
      request.method === "POST"
    ) {
      try {
        const body =
          await request.json();

        const endpoint =
          String(
            body.endpoint || ""
          ).trim();

        const p256dh =
          String(
            body?.keys?.p256dh ||
              ""
          ).trim();

        const auth =
          String(
            body?.keys?.auth ||
              ""
          ).trim();

        if (
          !endpoint ||
          !p256dh ||
          !auth
        ) {
          return json(
            {
              success: false,
              error:
                "اطلاعات اشتراک اعلان نامعتبر است."
            },
            400
          );
        }

        const subscription = {
          endpoint,

          expirationTime:
            body.expirationTime ??
            null,

          keys: {
            p256dh,
            auth
          }
        };

        const subscriptions =
          await getPushSubscriptions();

        const index =
          subscriptions.findIndex(
            item =>
              item.endpoint ===
              endpoint
          );

        if (index >= 0) {
          subscriptions[index] =
            subscription;
        } else {
          subscriptions.push(
            subscription
          );
        }

        await savePushSubscriptions(
          subscriptions.slice(
            -5000
          )
        );

        return json({
          success: true
        });
      } catch (error) {
        console.error(
          "Subscribe:",
          error
        );

        return json(
          {
            success: false,
            error:
              error?.message ||
              "ثبت اشتراک اعلان انجام نشد."
          },
          500
        );
      }
    }

    /* =====================================================
       API: UNSUBSCRIBE PUSH
       ===================================================== */

    if (
      path ===
        "/api/push/unsubscribe" &&
      request.method === "POST"
    ) {
      try {
        const body =
          await request.json();

        const endpoint =
          String(
            body.endpoint || ""
          ).trim();

        if (!endpoint) {
          return json(
            {
              success: false,
              error:
                "Endpoint نامعتبر است."
            },
            400
          );
        }

        const subscriptions =
          await getPushSubscriptions();

        const remaining =
          subscriptions.filter(
            item =>
              item.endpoint !==
              endpoint
          );

        await savePushSubscriptions(
          remaining
        );

        return json({
          success: true
        });
      } catch (error) {
        console.error(
          "Unsubscribe:",
          error
        );

        return json(
          {
            success: false,
            error:
              error?.message ||
              "لغو اعلان انجام نشد."
          },
          500
        );
      }
    }

    /* =====================================================
       API: TEST PUSH
       ===================================================== */

    if (
      path ===
        "/api/push/test" &&
      request.method === "POST"
    ) {
      const auth =
        request.headers.get(
          "Authorization"
        ) || "";

      if (
        auth !==
        "Bearer 4450"
      ) {
        return json(
          {
            success: false,
            error:
              "دسترسی غیرمجاز"
          },
          401
        );
      }

      const result =
        await broadcastPush({
          title:
            "🔔 تست اعلان ورونا",

          body:
            "اعلان آزمایشی فروشگاه سنگ ورونا.",

          url: "/"
        });

      return json(
        result,
        result.success
          ? 200
          : 500
      );
    }

    /* =====================================================
       API: PUSH STATUS
       ===================================================== */

    if (
      path ===
        "/api/push/status" &&
      request.method === "GET"
    ) {
      const subscriptions =
        await getPushSubscriptions();

      return json({
        success: true,
        count:
          subscriptions.length
      });
    }

    /* =====================================================
       REAL WEBSITE / ASSETS
       ===================================================== */

    /*
      VERY IMPORTANT:

      index.html, sw.js, manifest and images
      are served by Cloudflare Assets.

      There is NO fallback HTML here.

      If ASSETS is missing, the deployment itself
      is configured incorrectly.
    */

    if (
      !env.ASSETS ||
      typeof env.ASSETS.fetch !==
        "function"
    ) {
      return new Response(
        "ASSETS binding is not available. Deploy this Worker using the project's wrangler.jsonc configuration.",
        {
          status: 500,
          headers: {
            "Content-Type":
              "text/plain; charset=utf-8"
          }
        }
      );
    }

    return env.ASSETS.fetch(
      request
    );
  }
};
