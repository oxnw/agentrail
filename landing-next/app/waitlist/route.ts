import { NextRequest, NextResponse } from "next/server";

const DEFAULT_WAITLIST_API_URL = "https://api.agentrail.app/waitlist";

function resolveWaitlistApiUrl(): string {
  const configuredUrl = process.env.WAITLIST_API_URL?.trim();
  return configuredUrl && configuredUrl.length > 0 ? configuredUrl : DEFAULT_WAITLIST_API_URL;
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, idempotency-key",
      "cache-control": "no-store",
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": request.headers.get("content-type") ?? "application/json",
    };
    const idempotencyKey = request.headers.get("idempotency-key");
    if (idempotencyKey) {
      headers["idempotency-key"] = idempotencyKey;
    }

    const upstream = await fetch(resolveWaitlistApiUrl(), {
      method: "POST",
      headers,
      body: await request.text(),
      cache: "no-store",
    });

    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        error: {
          code: "waitlist_proxy_error",
          message: "Unable to reach the AgentRail waitlist API.",
          details: { message },
        },
      },
      { status: 502 },
    );
  }
}
