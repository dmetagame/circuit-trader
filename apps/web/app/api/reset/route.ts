import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST() {
  const s = getSession();
  s.reset();
  return NextResponse.json(await s.snapshot());
}
