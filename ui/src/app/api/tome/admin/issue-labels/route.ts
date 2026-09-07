import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";

import { authOptions } from "@/lib/auth-config";
import { isTomeAdmin } from "@/lib/rbac/tome-admin";
import { isTomeServerEnabled } from "@/lib/tome/guard";
import {
  readTomeIssueLabelSettings,
  saveTomeIssueLabelSettings,
  TomeIssueLabelSettingsValidationFailure,
} from "@/lib/tome/issue-tracker-store";
import type { TomeIssueLabelSettings } from "@/lib/tome/issue-filter-views";

export const dynamic = "force-dynamic";

type AdminSession = {
  user?: { email?: string | null };
};

async function adminEmail(): Promise<string | null> {
  const session = await getServerSession(authOptions) as AdminSession | null;
  if (!session?.user?.email || !(await isTomeAdmin(session))) return null;
  return session.user.email;
}

export async function GET() {
  if (!isTomeServerEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!(await adminEmail())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json({ data: await readTomeIssueLabelSettings() });
}

export async function PUT(request: NextRequest) {
  if (!isTomeServerEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const email = await adminEmail();
  if (!email) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json().catch(() => null) as Partial<TomeIssueLabelSettings> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  try {
    const settings = await saveTomeIssueLabelSettings(
      body as TomeIssueLabelSettings,
      email,
    );
    return NextResponse.json({ data: settings });
  } catch (error) {
    if (error instanceof TomeIssueLabelSettingsValidationFailure) {
      return NextResponse.json(
        { error: "Validation failed", errors: error.errors },
        { status: 422 },
      );
    }
    throw error;
  }
}
