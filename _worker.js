const NOTES_KEY = "verona:notes";
const MAX_NOTES = 1000;
const MAX_TEXT_LENGTH = 500;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Cache-Control": "no-store"
  };
}

async function getNotes(env) {
  const raw = await env.VERONA_NOTES.get(NOTES_KEY);

  if (!raw) {
    return [];
  }

  try {
    const notes = JSON.parse(raw);
    return Array.isArray(notes) ? notes : [];
  } catch {
    return [];
  }
}

async function saveNotes(env, notes) {
  await env.VERONA_NOTES.put(
    NOTES_KEY,
    JSON.stringify(notes)
  );
}

function apiResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders()
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /*
     * CORS / OPTIONS
     */
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    /*
     * ==========================
     * API: GET ALL NOTES
     * ==========================
     */
    if (url.pathname === "/api/notes" && request.method === "GET") {
      try {
        const notes = await getNotes(env);

        notes.sort((a, b) => {
          return Number(b.createdAt) - Number(a.createdAt);
        });

        return apiResponse({
          success: true,
          notes
        });
      } catch (error) {
        return apiResponse({
          success: false,
          error: "خطا در دریافت یادداشت‌ها"
        }, 500);
      }
    }

    /*
     * ==========================
     * API: ADD NOTE
     * ==========================
     */
    if (url.pathname === "/api/notes" && request.method === "POST") {
      try {
        let body;

        try {
          body = await request.json();
        } catch {
          return apiResponse({
            success: false,
            error: "اطلاعات ارسال شده صحیح نیست"
          }, 400);
        }

        const text = String(body?.text || "").trim();

        if (!text) {
          return apiResponse({
            success: false,
            error: "متن یادداشت خالی است"
          }, 400);
        }

        if (text.length > MAX_TEXT_LENGTH) {
          return apiResponse({
            success: false,
            error: `متن یادداشت حداکثر ${MAX_TEXT_LENGTH} کاراکتر باشد`
          }, 400);
        }

        const notes = await getNotes(env);

        const note = {
          id: crypto.randomUUID(),
          text,
          createdAt: Date.now()
        };

        notes.unshift(note);

        if (notes.length > MAX_NOTES) {
          notes.length = MAX_NOTES;
        }

        await saveNotes(env, notes);

        return apiResponse({
          success: true,
          note
        }, 201);

      } catch (error) {
        return apiResponse({
          success: false,
          error: "ثبت یادداشت انجام نشد"
        }, 500);
      }
    }

    /*
     * ==========================
     * API: DELETE NOTE
     * ==========================
     *
     * فعلاً حذف فقط زمانی مجاز است که
     * رمز مدیریت از سمت سایت ارسال شود.
     *
     * در مرحله بعد امنیت این بخش را
     * کامل‌تر می‌کنیم.
     */
    if (
      url.pathname.startsWith("/api/notes/") &&
      request.method === "DELETE"
    ) {
      try {
        const id = decodeURIComponent(
          url.pathname.replace("/api/notes/", "")
        ).trim();

        if (!id) {
          return apiResponse({
            success: false,
            error: "شناسه یادداشت مشخص نیست"
          }, 400);
        }

        const auth =
          request.headers.get("Authorization") || "";

        const password =
          auth.startsWith("Bearer ")
            ? auth.slice(7).trim()
            : "";

        /*
         * رمز فعلی مدیریت سایت
         * در مرحله امنیت نهایی بهتر است
         * به Secret کلادفلر منتقل شود.
         */
        if (password !== "4450") {
          return apiResponse({
            success: false,
            error: "دسترسی غیرمجاز"
          }, 403);
        }

        const notes = await getNotes(env);

        const newNotes = notes.filter(
          note => String(note.id) !== id
        );

        if (newNotes.length === notes.length) {
          return apiResponse({
            success: false,
            error: "یادداشت پیدا نشد"
          }, 404);
        }

        await saveNotes(env, newNotes);

        return apiResponse({
          success: true
        });

      } catch (error) {
        return apiResponse({
          success: false,
          error: "حذف یادداشت انجام نشد"
        }, 500);
      }
    }

    /*
     * ==========================
     * STATIC WEBSITE
     * ==========================
     *
     * هر چیزی که API نیست،
     * از فایل‌های اصلی سایت سرو می‌شود.
     */
    return env.ASSETS.fetch(request);
  }
};
