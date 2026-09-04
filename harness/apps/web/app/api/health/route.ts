export function GET() {
  return Response.json(
    {
      status: "ok",
      service: "zet-harness",
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
