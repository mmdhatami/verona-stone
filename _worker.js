export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /* =========================
       NOTES API
    ========================= */

    if (url.pathname === "/api/notes" && request.method === "GET") {
      return getNotes(env);
    }

    if (url.pathname === "/api/notes" && request.method === "POST") {
      return createNote(request, env);
    }

    if (
      url.pathname.startsWith("/api/notes/") &&
      request.method === "DELETE"
    ) {
      const id = decodeURIComponent(
        url.pathname.substring("/api/notes/".length)
      );

      return deleteNote(request, env, id);
    }

    /* =========================
       STATIC WEBSITE
    ========================= */

    return env.ASSETS.fetch(request);
  }
};


/* =========================================
   GET ALL NOTES
========================================= */

async function getNotes(env) {
  try {
    const index = await env.VERONA_NOTES.get("verona:notes:index", "json");

    const ids = Array.isArray(index) ? index : [];

    if (ids.length === 0) {
      return json({
        success: true,
        notes: []
      });
    }

    const notes = [];

    /*
      هر یادداشت کلید جدا دارد.
      این کار باعث می‌شود با اضافه شدن عکس و ویس،
      یک KV value بزرگ و خطرناک نسازیم.
    */

    for (const id of ids) {
      try {
        const note = await env.VERONA_NOTES.get(
          "verona:note:" + id,
          "json"
        );

        if (note) {
          notes.push(note);
        }
      } catch (error) {
        console.error("Could not read note:", id, error);
      }
    }

    notes.sort(
      (a, b) =>
        Number(b.createdAt || 0) -
        Number(a.createdAt || 0)
    );

    return json({
      success: true,
      notes
    });

  } catch (error) {
    console.error(error);

    return json(
      {
        success: false,
        error: "خطا در دریافت یادداشت‌ها"
      },
      500
    );
  }
}


/* =========================================
   CREATE NOTE
========================================= */

async function createNote(request, env) {
  try {
    const body = await request.json();

    const text = String(body.text || "").trim();
    const image = String(body.image || "");
    const voice = String(body.voice || "");

    if (!text && !image && !voice) {
      return json(
        {
          success: false,
          error: "یادداشت خالی است"
        },
        400
      );
    }

    if (text.length > 500) {
      return json(
        {
          success: false,
          error: "متن بیشتر از ۵۰۰ کاراکتر است"
        },
        400
      );
    }

    /* =========================
       IMAGE VALIDATION
    ========================= */

    if (image) {
      if (!image.startsWith("data:image/")) {
        return json(
          {
            success: false,
            error: "فرمت عکس نامعتبر است"
          },
          400
        );
      }

      /*
        حدود 900KB برای رشته Base64 عکس.
        عکس در سمت سایت قبل از ارسال فشرده می‌شود.
      */

      if (image.length > 900000) {
        return json(
          {
            success: false,
            error: "حجم عکس زیاد است"
          },
          413
        );
      }
    }

    /* =========================
       VOICE VALIDATION
    ========================= */

    if (voice) {
      const validVoice =
        voice.startsWith("data:audio/webm") ||
        voice.startsWith("data:audio/mp4") ||
        voice.startsWith("data:audio/ogg") ||
        voice.startsWith("data:audio/mpeg") ||
        voice.startsWith("data:audio/wav");

      if (!validVoice) {
        return json(
          {
            success: false,
            error: "فرمت ویس نامعتبر است"
          },
          400
        );
      }

      /*
        حدود 1.6MB برای ویس.
        سمت سایت نیز حداکثر ۳۰ ثانیه ضبط می‌کند.
      */

      if (voice.length > 2200000) {
        return json(
          {
            success: false,
            error: "حجم ویس زیاد است"
          },
          413
        );
      }
    }

    /* =========================
       CREATE NOTE
    ========================= */

    const id =
      Date.now().toString(36) +
      "-" +
      crypto.randomUUID();

    const note = {
      id,
      text,
      image,
      voice,
      createdAt: Date.now()
    };

    /*
      هر یادداشت در KV جدا ذخیره می‌شود.
    */

    await env.VERONA_NOTES.put(
      "verona:note:" + id,
      JSON.stringify(note)
    );

    /* =========================
       UPDATE INDEX
    ========================= */

    let index =
      await env.VERONA_NOTES.get(
        "verona:notes:index",
        "json"
      );

    if (!Array.isArray(index)) {
      index = [];
    }

    /*
      جدیدترین یادداشت اول
    */

    index = [
      id,
      ...index.filter(existingId => existingId !== id)
    ];

    /*
      حداکثر ۱۰۰۰ یادداشت.
      قدیمی‌ترین‌ها حذف می‌شوند.
    */

    const removedIds = index.slice(1000);

    index = index.slice(0, 1000);

    await env.VERONA_NOTES.put(
      "verona:notes:index",
      JSON.stringify(index)
    );

    /*
      پاک کردن یادداشت‌های خیلی قدیمی
    */

    for (const oldId of removedIds) {
      try {
        await env.VERONA_NOTES.delete(
          "verona:note:" + oldId
        );
      } catch (error) {
        console.error(
          "Could not remove old note:",
          oldId,
          error
        );
      }
    }

    return json({
      success: true,
      note
    });

  } catch (error) {
    console.error(error);

    return json(
      {
        success: false,
        error: "خطا در ثبت یادداشت"
      },
      500
    );
  }
}


/* =========================================
   DELETE NOTE
========================================= */

async function deleteNote(request, env, id) {
  try {

    const authorization =
      request.headers.get("Authorization") || "";

    if (authorization !== "Bearer 4450") {
      return json(
        {
          success: false,
          error: "دسترسی غیرمجاز"
        },
        401
      );
    }

    if (!id) {
      return json(
        {
          success: false,
          error: "شناسه یادداشت نامعتبر است"
        },
        400
      );
    }

    await env.VERONA_NOTES.delete(
      "verona:note:" + id
    );

    let index =
      await env.VERONA_NOTES.get(
        "verona:notes:index",
        "json"
      );

    if (!Array.isArray(index)) {
      index = [];
    }

    index = index.filter(
      existingId => existingId !== id
    );

    await env.VERONA_NOTES.put(
      "verona:notes:index",
      JSON.stringify(index)
    );

    return json({
      success: true
    });

  } catch (error) {
    console.error(error);

    return json(
      {
        success: false,
        error: "خطا در حذف یادداشت"
      },
      500
    );
  }
}


/* =========================================
   JSON RESPONSE
========================================= */

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "Cache-Control": "no-store"
      }
    }
  );
}
