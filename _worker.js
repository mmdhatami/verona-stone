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
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json; charset=utf-8"
        }
      });
    };

    /*
     * =========================================================
     * OPTIONS / CORS
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
     * IMPORTANT:
     * Static website files MUST be served independently
     * from API/Supabase.
     *
     * This prevents Supabase configuration problems from
     * breaking index.html and the catalog.
     * =========================================================
     */

    const isApiRequest = path.startsWith("/api/");

    /*
     * =========================================================
     * ENVIRONMENT
     * =========================================================
     */

    const SUPABASE_URL = env.supabase_url || "";
    const SUPABASE_KEY = env.cloudflare_worker || "";
    const BUCKET = "verona-media";
    const NOTES_KEY = "verona:notes";

    /*
     * =========================================================
     * KV HELPERS
     * =========================================================
     */

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
        console.error("getNotes error:", error);
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
     * SUPABASE HELPERS
     * =========================================================
     */

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
      if (!SUPABASE_URL || !SUPABASE_KEY) {
        throw new Error(
          "Supabase environment variables are not configured."
        );
      }

      if (!base64) {
        throw new Error("فایل خالی است.");
      }

      const binary = Uint8Array.from(
        atob(base64),
        c => c.charCodeAt(0)
      );

      const response = await fetch(
        `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${key}`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${SUPABASE_KEY}`,
            "apikey": SUPABASE_KEY,
            "Content-Type": contentType,
            "x-upsert": "true"
          },
          body: binary
        }
      );

      if (!response.ok) {
        const errorText = await response.text();

        throw new Error(
          `Supabase upload failed: ${errorText}`
        );
      }

      return supabaseStorageUrl(key);
    }

    async function deleteMedia(key) {
      if (!key) return;

      if (!SUPABASE_URL || !SUPABASE_KEY) {
        return;
      }

      try {
        await fetch(
          `${SUPABASE_URL}/storage/v1/object/${BUCKET}`,
          {
            method: "DELETE",
            headers: {
              "Authorization": `Bearer ${SUPABASE_KEY}`,
              "apikey": SUPABASE_KEY,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              prefixes: [key]
            })
          }
        );
      } catch (error) {
        console.error(
          "deleteMedia error:",
          error
        );
      }
    }

    /*
     * =========================================================
     * API: GET NOTES
     * =========================================================
     */

    if (
      path === "/api/notes" &&
      request.method === "GET"
    ) {
      const notes = await getNotes();

      return json({
        success: true,
        notes
      });
    }

    /*
     * =========================================================
     * API: CREATE NOTE
     * =========================================================
     */

    if (
      path === "/api/notes" &&
      request.method === "POST"
    ) {
      try {
        const body = await request.json();

        const text = String(
          body?.text || ""
        ).trim();

        const image =
          body?.image || null;

        const voice =
          body?.voice || null;

        if (!text && !image && !voice) {
          return json(
            {
              success: false,
              error: "یادداشت خالی است."
            },
            400
          );
        }

        const notes = await getNotes();

        const id =
          Date.now().toString(36) +
          "-" +
          Math.random()
            .toString(36)
            .slice(2, 10);

        const createdAt = Date.now();

        const note = {
          id,
          text,
          createdAt,
          image: null,
          voice: null
        };

        /*
         * -----------------------------------------------------
         * IMAGE
         * -----------------------------------------------------
         */

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

        /*
         * -----------------------------------------------------
         * VOICE
         * -----------------------------------------------------
         */

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

        notes.unshift(note);

        /*
         * حداکثر 1000 یادداشت
         */

        const limitedNotes =
          notes.slice(0, 1000);

        await saveNotes(
          limitedNotes
        );

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
     * API: DELETE NOTE
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
         * حذف عکس
         */

        if (
          note.image?.key
        ) {
          await deleteMedia(
            note.image.key
          );
        }

        /*
         * حذف صدا
         */

        if (
          note.voice?.key
        ) {
          await deleteMedia(
            note.voice.key
          );
        }

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
     * OTHER API ROUTES
     * =========================================================
     *
     * اگر API ناشناخته‌ای درخواست شد، پاسخ واضح می‌دهیم
     * و اجازه نمی‌دهیم به صفحه اصلی تبدیل شود.
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
     *
     * مهم‌ترین قسمت:
     *
     * /index.html
     * CSS
     * JS
     * تصاویر
     * manifest
     * sw.js
     *
     * همگی از ASSETS سرو می‌شوند.
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
     * اگر ASSETS وجود نداشته باشد،
     * به جای خطای مبهم، خطای واضح می‌دهیم.
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
