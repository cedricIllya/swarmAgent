import { NextResponse, type NextRequest } from "next/server";
import { publicHostAllowed } from "@/lib/public-host";

export function proxy(request: NextRequest) {
  // Ключ собран в рантайме: иначе сборка Next подставит пустой APP_URL из образа.
  const appUrl = process.env["APP_" + "URL"];
  if (publicHostAllowed(request.headers.get("host"), appUrl)) {
    return NextResponse.next();
  }
  return new NextResponse(null, { status: 404 });
}
