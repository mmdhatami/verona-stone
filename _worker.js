const NOTES_KEY = "verona:notes";
const POSTFILE_UPLOAD_URL = "https://postfile.net/v1/upload/base64";

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
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  headers.set(
    "Access-Control-Allow-Methods",
    "GET, POST, DELETE, OPTIONS"
  );

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
    const notes = await env.VERONA_NOTES.get(
      NOTES_KEY,
      "json"
    );

    return Array.isArray(notes) ? notes : [];
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

function normalizeBase64(value) {
  if (!value || typeof value !== "string") {
    return "";
  }

  /*
   * اگر فرانت‌اند به‌جای Base64 خام،
   * data:image/...;base64,... فرستاد،
   * قسمت ابتدایی را حذف می‌کنیم.
   */
  if (value.includes(",")) {
    const commaIndex = value.indexOf(",");

    if (
      value
        .slice(0, commaIndex)
        .toLowerCase()
        .includes("base64")
    ) {
      return value.slice(commaIndex + 1);
    }
  }

  return value;
}

function detectImageType(image) {
  if (
    image &&
    typeof image.type === "string" &&
    image.type.trim()
  ) {
    return image.type.trim();
  }

  if (
    image &&
    typeof image.content_type === "string" &&
    image.content_type.trim()
  ) {
    return image.content_type.trim();
  }

  return "image/jpeg";
}

function detectVoiceType(voice) {
  if (
    voice &&
    typeof voice.type === "string" &&
    voice.type.trim()
  ) {
    return voice.type.trim();
  }

  if (
    voice &&
    typeof voice.content_type === "string" &&
    voice.content_type.trim()
  ) {
    return voice.content_type.trim();
  }

  return "audio/webm";
}

function extensionFromType(type, fallback) {
  const clean = String(type || "").toLowerCase();

  if (clean.includes("jpeg")) return "jpg";
  if (clean.includes("jpg")) return "jpg";
  if (clean.includes("png")) return "png";
  if (clean.includes("webp")) return "webp";
  if (clean.includes("gif")) return "gif";
  if (clean.includes("heic")) return "heic";
  if (clean.includes("heif")) return "heif";

  if (clean.includes("webm")) return "webm";
  if (clean.includes("mpeg")) return "mp3";
  if (clean.includes("mp3")) return "mp3";
  if (clean.includes("wav")) return "wav";
  if (clean.includes("ogg")) return "ogg";
  if (clean.includes("mp4")) return "mp4";

  return fallback;
}

async function uploadToPostFile(
  env,
  base64,
  filename,
  contentType
) {
  if (!env.POSTFILE_API_KEY) {
    throw new Error(
      "POSTFILE_API_KEY is not configured"
    );
  }

  const cleanBase64 = normalizeBase64(base64);

  if (!cleanBase64) {
    throw new Error("File data is empty");
  }

  const response = await fetch(
    POSTFILE_UPLOAD_URL,
    {
      method: "POST",

      headers: {
        "X-API-Key": env.POSTFILE_API_KEY,
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        filename,
        content_type: contentType,
        data_base64: cleanBase64
      })
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      error: text
    };
  }

  if (!response.ok) {
    console.error(
      "PostFile upload failed:",
      response.status,
      data
    );

    throw new Error(
      data?.error ||
      data?.message ||
      `PostFile upload failed (${response.status})`
    );
  }

  if (!data.url) {
    throw new Error(
      "PostFile did not return a file URL"
    );
  }

  return {
    file_id: data.file_id || null,
    url: data.url,
    name: data.name || filename,
    size: data.size || null,
    content_type:
      data.content_type || contentType
  };
}

async function deleteFromPostFile(env, fileId) {
  if (!fileId || !env.POSTFILE_API_KEY) {
    return;
  }

  try {
    const response = await fetch(
      `https://postfile.net/v1/files/${encodeURIComponent(
        fileId
      )}`,
      {
        method: "DELETE",
        headers: {
          "X-API-Key": env.POSTFILE_API_KEY
        }
      }
    );

    if (!response.ok) {
      console.error(
        "PostFile delete failed:",
        response.status,
        await response.text()
      );
    }
  } catch (error) {
    console.error(
      "PostFile delete error:",
      error
    );
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    /*
     * =========================
     * OPTIONS / CORS
     * =========================
     */
    if (request.method === "OPTIONS") {
      return cors(
        new Response(null, {
          status: 204
        })
      );
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
      try {
        const notes = await getNotes(env);

        return json({
          ok: true,
          notes
        });
      } catch (error) {
        console.error(
          "GET /api/notes error:",
          error
        );

        return json(
          {
            ok: false,
            error: "دریافت یادداشت‌ها انجام نشد."
          },
          500
        );
      }
    }

    /*
     * =========================
     * CREATE NOTE
     * =========================
     */
    if (
      url.pathname === "/api/notes" &&
      request.method === "POST"
    ) {
      let uploadedImage = null;
      let uploadedVoice = null;

      try {
        const body = await request.json();

        const text =
          typeof body.text === "string"
            ? body.text.trim()
            : "";

        const image =
          body.image &&
          typeof body.image === "object"
            ? body.image
            : null;

        const voice =
          body.voice &&
          typeof body.voice === "object"
            ? body.voice
            : null;

        const imageBase64 =
          image &&
          typeof image.data === "string"
            ? image.data
            : "";

        const voiceBase64 =
          voice &&
          typeof voice.data === "string"
            ? voice.data
            : "";

        const hasImage =
          imageBase64.length > 0;

        const hasVoice =
          voiceBase64.length > 0;

        /*
         * یادداشت باید حداقل یکی از این‌ها را داشته باشد:
         * متن / عکس / ویس
         */
        if (
          !text &&
          !hasImage &&
          !hasVoice
        ) {
          return json(
            {
              ok: false,
              error:
                "یادداشت خالی است."
            },
            400
          );
        }

        /*
         * =========================
         * IMAGE UPLOAD
         * =========================
         */
        if (hasImage) {
          const imageType =
            detectImageType(image);

          const imageExt =
            extensionFromType(
              imageType,
              "jpg"
            );

          uploadedImage =
            await uploadToPostFile(
              env,
              imageBase64,
              `verona-note-image-${Date.now()}.${imageExt}`,
              imageType
            );
        }

        /*
         * =========================
         * VOICE UPLOAD
         * =========================
         */
        if (hasVoice) {
          const voiceType =
            detectVoiceType(voice);

          const voiceExt =
            extensionFromType(
              voiceType,
              "webm"
            );

          uploadedVoice =
            await uploadToPostFile(
              env,
              voiceBase64,
              `verona-note-voice-${Date.now()}.${voiceExt}`,
              voiceType
            );
        }

        /*
         * =========================
         * SAVE NOTE IN KV
         * =========================
         */
        const notes =
          await getNotes(env);

        const note = {
          id:
            Date.now().toString(36) +
            Math.random()
              .toString(36)
              .slice(2, 10),

          text,

          createdAt:
            new Date().toISOString(),

          image: uploadedImage
            ? {
                url: uploadedImage.url,
                file_id:
                  uploadedImage.file_id,
                name:
                  uploadedImage.name,
                size:
                  uploadedImage.size,
                content_type:
                  uploadedImage.content_type
              }
            : null,

          voice: uploadedVoice
            ? {
                url: uploadedVoice.url,
                file_id:
                  uploadedVoice.file_id,
                name:
                  uploadedVoice.name,
                size:
                  uploadedVoice.size,
                content_type:
                  uploadedVoice.content_type
              }
            : null
        };

        notes.unshift(note);

        /*
         * حداکثر 500 یادداشت آخر
         */
        const limitedNotes =
          notes.slice(0, 500);

        await saveNotes(
          env,
          limitedNotes
        );

        return json({
          ok: true,
          note
        });
      } catch (error) {
        console.error(
          "POST /api/notes error:",
          error
        );

        /*
         * اگر فایل آپلود شد ولی ذخیره
         * یادداشت در KV شکست خورد،
         * فایل اضافی را هم حذف می‌کنیم.
         */
        if (
          uploadedImage &&
          uploadedImage.file_id
        ) {
          ctx.waitUntil(
            deleteFromPostFile(
              env,
              uploadedImage.file_id
            )
          );
        }

        if (
          uploadedVoice &&
          uploadedVoice.file_id
        ) {
          ctx.waitUntil(
            deleteFromPostFile(
              env,
              uploadedVoice.file_id
            )
          );
        }

        const message =
          error?.message ||
          "ثبت یادداشت انجام نشد.";

        /*
         * خطاهای مربوط به API فایل
         * را واضح به فرانت‌اند می‌دهیم.
         */
        return json(
          {
            ok: false,
            error: message
          },
          500
        );
      }
    }

    /*
     * =========================
