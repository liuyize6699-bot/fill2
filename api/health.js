export const config = { runtime: "edge" };

export default async function handler() {
  return new Response(JSON.stringify({
    ok: true,
    coze: {
      has_token: Boolean(process.env.COZE_API_TOKEN),
      has_bot_id: Boolean(process.env.COZE_BOT_ID)
    }
  }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
