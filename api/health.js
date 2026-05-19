export const config = { runtime: "edge" };

export default async function handler() {
  return new Response(JSON.stringify({
    ok: true,
    minimax: {
      has_api_key: Boolean(process.env.MINIMAX_API_KEY),
      model: process.env.MINIMAX_MODEL || "MiniMax-M2.7"
    }
  }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
