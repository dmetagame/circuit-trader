import { timingSafeEqual } from "node:crypto";
import { get, put } from "@vercel/blob";
import { NextRequest, NextResponse } from "next/server";
import { isLiveEnvelope, type LiveEnvelope } from "@/lib/live";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SNAPSHOT_PATH = "circuit-trader/live/latest.json";

export async function GET() {
  try {
    const result = await get(SNAPSHOT_PATH, { access: "private", useCache: false });
    if (!result) return NextResponse.json({ available: false }, { status: 404 });
    const value: unknown = await new Response(result.stream).json();
    if (!isLiveEnvelope(value)) {
      return NextResponse.json({ error: "stored live snapshot is invalid" }, { status: 500 });
    }
    return NextResponse.json(value, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isMissingBlobConfiguration(error)) {
      return NextResponse.json({ available: false }, { status: 404 });
    }
    throw error;
  }
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const value: unknown = await request.json();
  if (!isLiveEnvelope(value)) return NextResponse.json({ error: "invalid live snapshot" }, { status: 400 });

  const envelope: LiveEnvelope = {
    updatedAt: value.updatedAt,
    snapshot: { ...value.snapshot, timeline: value.snapshot.timeline.slice(0, 50) },
  };
  await put(SNAPSHOT_PATH, JSON.stringify(envelope), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
  return NextResponse.json({ ok: true, updatedAt: envelope.updatedAt });
}

function authorized(request: NextRequest): boolean {
  const expected = process.env.LIVE_INGEST_SECRET;
  const header = request.headers.get("authorization");
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!expected || !provided) return false;
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

function isMissingBlobConfiguration(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("BLOB_READ_WRITE_TOKEN") || message.includes("Blob store");
}
