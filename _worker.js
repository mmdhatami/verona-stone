export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      });

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

    const SUPABASE_URL = env.supabase_url;
    const SUPABASE_KEY = env.cloudflare_worker;
    const BUCKET = "verona-media";
    const NOTES_KEY = "verona:notes";

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return json({
        success: false,
        error: "Supabase environment variables are not configured."
      }, 500);
    }

    async function getNotes() {
      try {
        const value = await env.VERONA_NOTES.get(NOTES_KEY, "json");
        return Array.isArray(value) ? value : [];
      } catch {
        return [];
      }
    }

    async function saveNotes(notes) {
      await env.VERONA_NOTES.put(NOTES_KEY, JSON.stringify(notes));
    }

    function supabaseStorageUrl(key) {
      return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${key}`;
    }

    async function uploadMedia(key, base64, contentType) {
      const binary = Uint8Array.from(atob(base64), c => c.charCodeAt(0));

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
        throw new Error(`Supabase upload failed: ${errorText}`);
      }

      return supabaseStorageUrl(key);
    }

    async function deleteMedia(key) {
      if (!key) return;

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
      } catch {}
    }

    // =========================
    // GET NOTES
    // =========================
    if (path === "/api/notes" && request.method === "GET") {
      const notes = await getNotes();

      return json({
        success: true,
        notes
      });
    }

    // =========================
    // CREATE NOTE
    // =========================
    if (path === "/api/notes" && request.method === "POST") {
      try {
        const body = await request.json();

        const text = String(body.text || "").trim();
        const image = body.image || null;
        const voice = body.voice || null;

        if (!text && !image && !voice) {
          return json({
            success: false,
            error: "یادداشت خالی است."
          }, 400);
        }

        const notes = await getNotes();

        const id =
          Date.now().toString(36) +
          "-" +
          Math.random().toString(36).slice(2, 10);

        const createdAt = Date.now();

        const note = {
          id,
          text,
          createdAt,
          image: null,
          voice: null
        };

        // =========================
        // IMAGE
        // =========================
        if (image && image.data) {
          const imageKey = `notes/${id}/image.jpg`;

          const imageUrl = await uploadMedia(
            imageKey,
            image.data,
            "image/jpeg"
          );

          note.image = {
            url: imageUrl,
            key: imageKey
          };
        }

        // =========================
        // VOICE
        // =========================
        if (voice && voice.data) {
          const voiceKey = `notes/${id}/voice.webm`;

          const voiceUrl = await uploadMedia(
            voiceKey,
            voice.data,
            "audio/webm"
          );

          note.voice = {
            url: voiceUrl,
            key: voiceKey
          };
        }

        notes.unshift(note);

        // حداکثر 1000 یادداشت
        const limitedNotes = notes.slice(0, 1000);

        await saveNotes(limitedNotes);

        return json({
          success: true,
          note
        });

      } catch (error) {
        return json({
          success: false,
          error: error?.message || "خطا در ثبت یادداشت"
        }, 500);
      }
    }

    // =========================
    // DELETE NOTE
    // =========================
    if (
      path.startsWith("/api/notes/") &&
      request.method === "DELETE"
    ) {
      const auth = request.headers.get("Authorization") || "";

      if (auth !== "Bearer 4450") {
        return json({
          success: false,
          error: "دسترسی غیرمجاز"
        }, 401);
      }

      const id = decodeURIComponent(
        path.replace("/api/notes/", "")
      );

      if (!id) {
        return json({
          success: false,
          error: "شناسه یادداشت نامعتبر است."
        }, 400);
      }

      const notes = await getNotes();

      const note = notes.find(n => String(n.id) === String(id));

      if (!note) {
        return json({
          success: false,
          error: "یادداشت پیدا نشد."
        }, 404);
      }

      // حذف عکس از Supabase
      if (note.image?.key) {
        await deleteMedia(note.image.key);
      }

      // حذف صدا از Supabase
      if (note.voice?.key) {
        await deleteMedia(note.voice.key);
      }

      const remaining = notes.filter(
        n => String(n.id) !== String(id)
      );

      await saveNotes(remaining);

      return json({
        success: true
      });
    }

    // =========================
    // DEFAULT STATIC ASSETS
    // =========================
    return env.ASSETS.fetch(request);
  }
};
