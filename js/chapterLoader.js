export async function loadChapterMeta(lang, chapterNumber) {
  const path = `chapters/${lang}/chapter${chapterNumber}/meta.json`;

  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`Missing meta.json at ${path}`);
    const meta = await res.json();
    return meta;
  } catch (err) {
    console.error(`Error loading chapter metadata: ${err.message}`);
    return null;
  }
}