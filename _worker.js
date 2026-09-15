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

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    const NOTES_KEY = "verona:notes";

    const isApiRequest = path.startsWith("/api/");

    /*
     * =========================================================
     * KV - NOTES
     * =========================================================
     */

    async function getNotes() {

      if (!env.VERONA_NOTES) {
        throw new Error(
          "VERONA_NOTES binding is not configured."
        );
      }

      try {

        const value = await env.VERONA_NOTES.get(
          NOTES_KEY,
          "json"
        );

        return Array.isArray(value)
          ? value
          : [];

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
     * R2 - MEDIA
     * =========================================================
     */

    function hasR2() {
      return Boolean(env.VERONA_MEDIA);
    }

    /*
     * =========================================================
     * API: GET MEDIA
     *
     * /api/media/notes/xxxx/image.jpg
     * /api/media/notes/xxxx/voice.webm
     * =========================================================
     */

    if (
      path.startsWith("/api/media/") &&
      request.method === "GET"
    ) {

      if (!hasR2()) {
        return new Response(
          "VERONA_MEDIA R2 binding is not configured.",
          {
            status: 500,
            headers: {
              "Content-Type":
                "text/plain; charset=utf-8"
            }
          }
        );
      }

      const key = decodeURIComponent(
        path.replace("/api/media/", "")
      );

      if (!key) {
        return new Response(
          "Media key is missing.",
          {
            status: 400
          }
        );
      }

      try {

        const object =
          await env.VERONA_MEDIA.get(key);

        if (!object) {

          return new Response(
            "File not found.",
            {
              status: 404
            }
          );
        }

        const headers = new Headers();

        object.writeHttpMetadata(headers);

        headers.set(
          "etag",
          object.httpEtag
        );

        headers.set(
          "Cache-Control",
          "public, max-age=31536000, immutable"
        );

        return new Response(
          object.body,
          {
            status: 200,
            headers
          }
        );

      } catch (error) {

        console.error(
          "GET MEDIA ERROR:",
          error
        );

        return new Response(
          "خطا در دریافت فایل.",
          {
            status: 500
          }
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
     * API: CREATE NOTE
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
         * اگر عکس یا صدا وجود دارد،
         * باید R2 فعال باشد.
         */

        if (
          (hasImage || hasVoice) &&
          !hasR2()
        ) {

          return json(
            {
              success: false,
              error:
                "فضای ذخیره‌سازی Cloudflare R2 هنوز متصل نشده است."
            },
            500
          );
        }

        const notes =
          await getNotes();

        const id =
          Date.now().toString(36) +
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

        /*
         * =====================================================
         * IMAGE
         * =====================================================
         */

        if (hasImage) {

          const contentType =
            image.type ||
            "image/jpeg";

          const extension =
            contentType.includes("png")
              ? "png"
              : contentType.includes("webp")
              ? "webp"
              : contentType.includes("gif")
              ? "gif"
              : "jpg";

          const imageKey =
            `notes/${id}/image.${extension}`;

          try {

            const binary =
              Uint8Array.from(
                atob(image.data),
                char =>
                  char.charCodeAt(0)
              );

            await env.VERONA_MEDIA.put(
              imageKey,
              binary,
              {
                httpMetadata: {
                  contentType
                }
              }
            );

          } catch (error) {

            console.error(
              "IMAGE UPLOAD ERROR:",
              error
            );

            throw new Error(
              "آپلود عکس انجام نشد."
            );
          }

          note.image = {

            url:
              `/api/media/${encodeURIComponent(
                imageKey
              )}`,

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

          const contentType =
            voice.type ||
            "audio/webm";

          const voiceKey =
            `notes/${id}/voice.webm`;

          try {

            const binary =
              Uint8Array.from(
                atob(voice.data),
                char =>
                  char.charCodeAt(0)
              );

            await env.VERONA_MEDIA.put(
              voiceKey,
              binary,
              {
                httpMetadata: {
                  contentType
                }
              }
            );

          } catch (error) {

            console.error(
              "VOICE UPLOAD ERROR:",
              error
            );

            throw new Error(
              "آپلود صدا انجام نشد."
            );
          }

          note.voice = {

            url:
              `/api/media/${encodeURIComponent(
                voiceKey
              )}`,

            key:
              voiceKey
          };
        }

        /*
         * =====================================================
         * SAVE NOTE
         * =====================================================
         */

        notes.unshift(note);

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
         * حذف عکس از R2
         */

        if (
          note.image &&
          note.image.key &&
          hasR2()
        ) {

          try {

            await env.VERONA_MEDIA.delete(
              note.image.key
            );

          } catch (error) {

            console.error(
              "DELETE IMAGE ERROR:",
              error
            );
          }
        }

        /*
         * حذف صدا از R2
         */

        if (
          note.voice &&
          note.voice.key &&
          hasR2()
        ) {

          try {

            await env.VERONA_MEDIA.delete(
              note.voice.key
            );

          } catch (error) {

            console.error(
              "DELETE VOICE ERROR:",
              error
            );
          }
        }

        /*
         * حذف یادداشت از KV
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
