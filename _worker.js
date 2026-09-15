const NOTES_KEY = "verona:notes";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS"
    }
  });
}

function cors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function getNotes(env) {
  if (!env.VERONA_NOTES) {
    return [];
  }

  try {
    const data = await env.VERONA_NOTES.get(NOTES_KEY, "json");
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error("getNotes error:", error);
    return [];
  }
}

async function saveNotes(env, notes) {
  if (!env.VERONA_NOTES) {
    throw new Error("VERONA_NOTES binding is missing");
  }

  await env.VERONA_NOTES.put(
    NOTES_KEY,
    JSON.stringify(notes)
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    /*
     * =========================
     * GET NOTES
     * =========================
     */
    if (
      url.pathname === "/api/notes" &&
      request.method === "GET"
    ) {
      const notes = await getNotes(env);

      return json({
        ok: true,
        notes
      });
    }

    /*
     * =========================
     * ADD NOTE
     * =========================
     */
    if (
      url.pathname === "/api/notes" &&
      request.method === "POST"
    ) {
      try {
        const body = await request.json();

        const text =
          typeof body.text === "string"
            ? body.text.trim()
            : "";

        const hasImage =
          body.image &&
          typeof body.image.data === "string" &&
          body.image.data.length > 0;

        const hasVoice =
          body.voice &&
          typeof body.voice.data === "string" &&
          body.voice.data.length > 0;

        /*
         * فعلاً چون R2/Supabase نداریم،
         * فایل‌های عکس و صدا ذخیره نمی‌شوند.
         *
         * به جای خراب شدن کل درخواست،
         * پیام واضح به کاربر برمی‌گردانیم.
         */
        if (hasImage || hasVoice) {
          return json(
            {
              ok: false,
              error:
                "ذخیره عکس و ویس فعلاً فعال نیست. ابتدا فضای ذخیره‌سازی فایل را متصل می‌کنیم."
            },
            503
          );
        }

        if (!text) {
          return json(
            {
              ok: false,
              error: "متن یادداشت خالی است."
            },
            400
          );
        }

        const notes = await getNotes(env);

        const note = {
          id:
            Date.now().toString(36) +
            Math.random().toString(36).slice(2, 8),

          text,

          createdAt: new Date().toISOString(),

          image: null,

          voice: null
        };

        notes.unshift(note);

        /*
         * حداکثر 500 یادداشت نگه می‌داریم
         * تا KV بی‌دلیل پر نشود.
         */
        const limitedNotes = notes.slice(0, 500);

        await saveNotes(env, limitedNotes);

        return json({
          ok: true,
          note
        });
      } catch (error) {
        console.error("POST /api/notes error:", error);

        return json(
          {
            ok: false,
            error: "ثبت یادداشت انجام نشد."
          },
          500
        );
      }
    }

    /*
     * =========================
     * DELETE NOTE
     * =========================
     */
    if (
      url.pathname.startsWith("/api/notes/") &&
      request.method === "DELETE"
    ) {
      try {
        const auth =
          request.headers.get("Authorization") || "";

        if (auth !== "Bearer 4450") {
          return json(
            {
              ok: false,
              error: "دسترسی غیرمجاز"
            },
            401
          );
        }

        const id = decodeURIComponent(
          url.pathname.substring("/api/notes/".length)
        );

        if (!id) {
          return json(
            {
              ok: false,
              error: "شناسه یادداشت مشخص نیست."
            },
            400
          );
        }

        const notes = await getNotes(env);

        const newNotes = notes.filter(
          note => String(note.id) !== String(id)
        );

        if (newNotes.length === notes.length) {
          return json(
            {
              ok: false,
              error: "یادداشت پیدا نشد."
            },
            404
          );
        }

        await saveNotes(env, newNotes);

        return json({
          ok: true,
          message: "یادداشت حذف شد."
        });
      } catch (error) {
        console.error("DELETE /api/notes error:", error);

        return json(
          {
            ok: false,
            error: "حذف یادداشت انجام نشد."
          },
          500
        );
      }
    }

    /*
     * =========================
     * UNKNOWN API
     * =========================
     */
    if (url.pathname.startsWith("/api/")) {
      return json(
        {
          ok: false,
          error: "API endpoint not found"
        },
        404
      );
    }

    /*
     * =========================
     * STATIC WEBSITE
     * =========================
     */
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response(
      "ASSETS binding is not configured.",
      {
        status: 500,
        headers: {
          "Content-Type": "text/plain; charset=UTF-8"
        }
      }
    );
  }
};
