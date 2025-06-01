export async function loadConfig() {
  try {
    const res = await fetch('config.json');
    if (!res.ok) throw new Error('Failed to load config.json');
    const config = await res.json();
    return config;
  } catch (err) {
    console.error('Error loading config:', err);
    return null;
  }
}