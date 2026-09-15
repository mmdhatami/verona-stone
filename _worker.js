export default {
  async fetch(request, env, ctx) {

    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };

    const json = (data, status = 200) => {
      return new Response(
        JSON.stringify(data),
        {
          status,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json; charset=utf-8"
          }
        }
      );
    };

    /*
     * =========================================================
     * CORS
     * =========================================================
     */

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    /*
     * =========================================================
     * ENVIRONMENT
     * =========================================================
     */

    const SUPABASE_URL =
      env.supabase_url || "";

    const SUPABASE_KEY =
      env.cloudflare_worker || "";

    const BUCKET =
      "verona-media";

    const NOTES_KEY =
      "verona:notes";

    const isApiRequest =
      path.startsWith("/api/");

    /*
     * =========================================================
     * KV
     * =========================================================
     */

    async function getNotes() {

      if (!env.VERONA_NOTES) {
        throw new Error(
          "VERONA_NOTES binding is not configured."
        );
      }

      try {

        const value =
          await env.VERONA_NOTES.get(
            NOTES_KEY,
            "json"
          );

        if (Array.isArray(value)) {
          return value;
        }

        return [];

      } catch (error) {

        console.error(
          "GET NOTES ERROR:",
          error
        );

        return [];
      }
    }

    async function saveNotes(notes) {

      if (!env.VERONA_NOTES) {
        throw new Error(
          "VERONA_NOTES binding is not configured."
        );
      }

      await env.VERONA_NOTES.put(
        NOTES_KEY,
        JSON.stringify(notes)
      );
    }

    /*
     * =========================================================
     * SUPABASE
     * =========================================================
     */

    function hasSupabase() {

      return Boolean(
        SUPABASE_URL &&
        SUPABASE_KEY
      );
    }

    function supabaseStorageUrl(key) {

      if (!SUPABASE_URL) {
        return "";
      }

      return (
        `${SUPABASE_URL}` +
        `/storage/v1/object/public/${BUCKET}/${key}`
      );
    }

    async function uploadMedia(
      key,
      base64,
      contentType
    ) {

      if (!hasSupabase()) {

        throw new Error(
          "برای ثبت عکس یا صدا، اتصال Supabase در Cloudflare تنظیم نشده است."
        );
      }

      if (!base64) {

        throw new Error(
          "فایل ارسالی خالی است."
        );
      }

      let binary;

      try {

        binary =
          Uint8Array.from(
            atob(base64),
            char =>
              char.charCodeAt(0)
          );

      } catch (error) {

        throw new Error(
          "فرمت فایل ارسالی نامعتبر است."
        );
      }

      const response =
        await fetch(
          `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${key}`,
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

            body: binary
          }
        );

      if (!response.ok) {

        const errorText =
          await response.text();

        console.error(
          "SUPABASE UPLOAD ERROR:",
          errorText
        );

        throw new Error(
          "آپلود فایل در Supabase انجام نشد."
        );
      }

      return supabaseStorageUrl(
        key
      );
    }

    async function deleteMedia(key) {

      if (!key) {
        return;
      }

      if (!hasSupabase()) {
        return;
      }

      try {

        await fetch(
          `${SUPABASE_URL}/storage/v1/object/${BUCKET}`,
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

            body: JSON.stringify({
              prefixes: [key]
            })
          }
        );

      } catch (error) {

        console.error(
          "DELETE MEDIA ERROR:",
          error
        );
      }
    }

    /*
     * =========================================================
     * GET NOTES
     * =========================================================
     */

    if (
      path === "/api/notes" &&
      request.method === "GET"
    ) {

      try {

        const notes =
          await getNotes();

        return json({
          success: true,
          notes
        });

      } catch (error) {

        return json(
          {
            success: false,
            error:
              error?.message ||
              "خطا در دریافت یادداشت‌ها"
          },
          500
        );
      }
    }

    /*
     * =========================================================
     * CREATE NOTE
     * =========================================================
     */

    if (
      path === "/api/notes" &&
      request.method === "POST"
    ) {

      try {

        const body =
          await request.json();

        const text =
          String(
            body?.text || ""
          ).trim();

        const image =
          body?.image || null;

        const voice =
          body?.voice || null;

        /*
         * فقط وقتی واقعاً data وجود دارد
         * فایل را پردازش می‌کنیم.
         */

        const hasImage =
          Boolean(
            image &&
            typeof image === "object" &&
            image.data
          );

        const hasVoice =
          Boolean(
            voice &&
            typeof voice === "object" &&
            voice.data
          );

        /*
         * یادداشت کاملاً خالی
         */

        if (
          !text &&
          !hasImage &&
          !hasVoice
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

        /*
         * گرفتن یادداشت‌های قبلی
         */

        const notes =
          await getNotes();

        /*
         * شناسه یکتا
         */

        const id =
          Date.now().toString(36) +
          "-" +
          Math.random()
            .toString(36)
            .slice(2, 10);

        const createdAt =
          Date.now();

        /*
         * یادداشت جدید
         */

        const note = {

          id,

          text,

          createdAt,

          image: null,

          voice: null
        };

        /*
         * =====================================================
         * IMAGE
         * =====================================================
         */

        if (hasImage) {

          const imageKey =
            `notes/${id}/image`;

          const imageType =
            image.type ||
            "image/jpeg";

          const imageUrl =
            await uploadMedia(
              imageKey,
              image.data,
              imageType
            );

          note.image = {

            url:
              imageUrl,

            key:
              imageKey
          };
        }

        /*
         * =====================================================
         * VOICE
         * =====================================================
         */

        if (hasVoice) {

          const voiceKey =
            `notes/${id}/voice.webm`;

          const voiceType =
            voice.type ||
            "audio/webm";

          const voiceUrl =
            await uploadMedia(
              voiceKey,
              voice.data,
              voiceType
            );

          note.voice = {

            url:
              voiceUrl,

            key:
              voiceKey
          };
        }

        /*
         * =====================================================
         * SAVE
         * =====================================================
         */

        notes.unshift(note);

        const limitedNotes =
          notes.slice(0, 1000);

        await saveNotes(
          limitedNotes
        );

        /*
         * =====================================================
         * SUCCESS
         * =====================================================
         */

        return json({

          success: true,

          note

        });

      } catch (error) {

        console.error(
          "CREATE NOTE ERROR:",
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

    /*
     * =========================================================
     * DELETE NOTE
     * =========================================================
     */

    if (
      path.startsWith("/api/notes/") &&
      request.method === "DELETE"
    ) {

      try {

        const auth =
          request.headers.get(
            "Authorization"
          ) || "";

        if (
          auth !== "Bearer 4450"
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
            n =>
              String(n.id) ===
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

        /*
         * حذف عکس از Supabase
         */

        if (
          note.image &&
          note.image.key
        ) {

          await deleteMedia(
            note.image.key
          );
        }

        /*
         * حذف صدا از Supabase
         */

        if (
          note.voice &&
          note.voice.key
        ) {

          await deleteMedia(
            note.voice.key
          );
        }

        /*
         * حذف از KV
         */

        const remaining =
          notes.filter(
            n =>
              String(n.id) !==
              String(id)
          );

        await saveNotes(
          remaining
        );

        return json({

          success: true

        });

      } catch (error) {

        console.error(
          "DELETE NOTE ERROR:",
          error
        );

        return json(
          {
            success: false,

            error:
              error?.message ||
              "خطا در حذف یادداشت"
          },
          500
        );
      }
    }

    /*
     * =========================================================
     * UNKNOWN API
     * =========================================================
     */

    if (isApiRequest) {

      return json(
        {
          success: false,

          error:
            "API route not found.",

          path
        },
        404
      );
    }

    /*
     * =========================================================
     * STATIC WEBSITE
     * =========================================================
     */

    if (
      env.ASSETS &&
      typeof env.ASSETS.fetch ===
        "function"
    ) {

      return env.ASSETS.fetch(
        request
      );
    }

    /*
     * =========================================================
     * ASSETS ERROR
     * =========================================================
     */

    return new Response(
      "ASSETS binding is not available. Please deploy this Worker with wrangler.jsonc.",
      {
        status: 500,

        headers: {
          "Content-Type":
            "text/plain; charset=utf-8"
        }
      }
    );
  }
};
