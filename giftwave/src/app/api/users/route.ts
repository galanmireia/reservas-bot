import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const onboardingSchema = z.object({
  username: z.string().min(3).max(30).regex(/^[a-z0-9_]+$/),
  displayName: z.string().min(1).max(50),
  bio: z.string().max(160).optional(),
  referralCode: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const clerkUser = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
    headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` },
  }).then((r) => r.json());

  const body = await req.json();
  const parsed = onboardingSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { username, displayName, bio, referralCode } = parsed.data;

  // Check username availability
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) return NextResponse.json({ error: "Username taken" }, { status: 409 });

  // Resolve referrer
  let referredById: string | undefined;
  if (referralCode) {
    const referrer = await prisma.user.findUnique({ where: { referralCode } });
    if (referrer) referredById = referrer.id;
  }

  const user = await prisma.user.create({
    data: {
      clerkId: userId,
      email: clerkUser.email_addresses?.[0]?.email_address ?? "",
      username,
      displayName,
      bio,
      avatarUrl: clerkUser.image_url,
      referredById,
      wishlists: {
        create: { title: "My Wishlist", isDefault: true },
      },
    },
  });

  return NextResponse.json({ user });
}
