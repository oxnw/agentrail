import { NextRequest, NextResponse } from 'next/server';

const MINTLIFY_BASE = 'https://agentrail.mintlify.app';
const CUSTOM_HOST = 'agentrail.app';

const FORWARD_HEADERS = ['content-type', 'cache-control', 'etag', 'last-modified', 'vary'];

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug?: string[] }> }
) {
  const { slug } = await params;
  const path = slug ? slug.join('/') : '';
  const { search } = new URL(request.url);

  const upstream = await fetch(`${MINTLIFY_BASE}/${path}${search}`, {
    headers: {
      'x-forwarded-host': CUSTOM_HOST,
      'x-forwarded-proto': 'https',
      accept: request.headers.get('accept') ?? '*/*',
      'accept-language': request.headers.get('accept-language') ?? 'en',
      'user-agent': request.headers.get('user-agent') ?? '',
    },
    redirect: 'manual',
  });

  const body = await upstream.arrayBuffer();
  const headers = new Headers();
  for (const h of FORWARD_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }

  return new NextResponse(body, { status: upstream.status, headers });
}
