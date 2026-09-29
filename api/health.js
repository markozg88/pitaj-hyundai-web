export const config = { runtime: 'edge' };
export default async function handler() {
  return Response.json({
    ok: true,
    llm: !!process.env.ANTHROPIC_API_KEY,
    bff: !!(process.env.PHOEBE_BFF_URL && process.env.PHOEBE_MACHINE_KEY),
    demo: process.env.ALLOW_DEMO === '1',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
