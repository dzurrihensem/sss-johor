// API pangkalan data Pemarkahan SSS Muzik (Netlify Functions + Netlify Blobs)
import { getStore } from "@netlify/blobs";

export const config = { path: "/api/*" };

const ID = /^[A-Za-z0-9_-]{1,48}$/;
const json = (d, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

function accessCode() {
  try { if (globalThis.Netlify && Netlify.env) { const v = Netlify.env.get("ACCESS_CODE"); if (v) return v; } } catch (e) {}
  return process.env.ACCESS_CODE || "";
}

async function listKeys(store, prefix) {
  const { blobs } = await store.list({ prefix });
  return blobs.map((b) => b.key);
}

async function inChunks(items, n, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(...(await Promise.all(items.slice(i, i + n).map(fn))));
  return out;
}

function decodeImage(body) {
  // terima data URL (data:image/jpeg;base64,...) atau base64 biasa
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/s.exec(body.trim());
  const b64 = m ? m[2] : body.trim();
  const buf = Buffer.from(b64, "base64");
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

export default async (req) => {
  const code = accessCode();
  if (!code) return json({ error: "ACCESS_CODE belum ditetapkan. Tetapkan dalam Netlify: Site configuration > Environment variables, kemudian deploy semula." }, 500);

  const url = new URL(req.url);
  const given = req.headers.get("x-kod") || url.searchParams.get("k") || "";
  if (given !== code) return json({ error: "Kod akses salah" }, 401);

  const store = getStore({ name: "sss-muzik", consistency: "strong" });
  const [res, id] = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const m = req.method;

  try {
    if (res === "ping") return json({ ok: true });

    // semua data calon + tetapan
    if (res === "data" && m === "GET") {
      const keys = await listKeys(store, "c/");
      const cands = (await inChunks(keys, 25, (k) => store.get(k, { type: "json" }))).filter(Boolean);
      const meta = (await store.get("meta", { type: "json" })) || {};
      cands.sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0));
      return json({ cands, meta, now: Date.now() });
    }

    // satu calon
    if (res === "cands" && id) {
      if (!ID.test(id)) return json({ error: "ID tidak sah" }, 400);
      if (m === "PUT") {
        const text = await req.text();
        if (text.length > 100000) return json({ error: "Data terlalu besar" }, 413);
        const c = JSON.parse(text);
        c.id = id; c.updatedAt = Date.now();
        await store.setJSON("c/" + id, c);
        return json({ ok: true, updatedAt: c.updatedAt });
      }
      if (m === "DELETE") {
        await store.delete("c/" + id); await store.delete("f/" + id);
        return json({ ok: true });
      }
    }

    // import pukal / ganti semua
    if (res === "bulk" && m === "POST") {
      const { mode, cands } = await req.json();
      if (!Array.isArray(cands)) return json({ error: "Format tidak sah" }, 400);
      const now = Date.now();
      const ids = new Set();
      cands.forEach((c) => { if (c && ID.test(c.id)) ids.add(c.id); });
      if (mode === "replace") {
        const old = [...(await listKeys(store, "c/")), ...(await listKeys(store, "f/"))].filter((k) => !ids.has(k.slice(2)));
        await inChunks(old, 25, (k) => store.delete(k));
      }
      await inChunks(cands.filter((c) => c && ID.test(c.id)), 25, (c) => store.setJSON("c/" + c.id, Object.assign(c, { updatedAt: now })));
      return json({ ok: true, count: ids.size, updatedAt: now });
    }

    // tetapan umum
    if (res === "meta" && m === "PUT") {
      const meta = await req.json();
      await store.setJSON("meta", { defPanel: String(meta.defPanel || "").slice(0, 200) });
      return json({ ok: true });
    }

    // foto calon
    if (res === "foto" && id) {
      if (!ID.test(id)) return json({ error: "ID tidak sah" }, 400);
      if (m === "GET") {
        const buf = await store.get("f/" + id, { type: "arrayBuffer" });
        if (!buf) return new Response("Tiada foto", { status: 404 });
        return new Response(buf, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=31536000, immutable" } });
      }
      if (m === "PUT") {
        const text = await req.text();
        if (text.length > 3000000) return json({ error: "Foto terlalu besar" }, 413);
        await store.set("f/" + id, decodeImage(text));
        return json({ ok: true, v: Date.now() });
      }
      if (m === "DELETE") { await store.delete("f/" + id); return json({ ok: true }); }
    }

    return json({ error: "Laluan tidak dijumpai" }, 404);
  } catch (e) {
    return json({ error: "Ralat pelayan: " + (e && e.message ? e.message : String(e)) }, 500);
  }
};
