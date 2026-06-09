import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const itemSchema = z.object({
  wishlistId: z.string(),
  type: z.enum(["PRODUCT", "CASH", "DIGITAL"]),
  title: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  imageUrl: z.string().url().optional(),
  price: z.number().positive().max(10000),
  currency: z.string().default("USD"),
  productUrl: z.string().url().optional(),
});

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { clerkId: userId },
    include: {
      wishlists: {
        include: { items: { orderBy: { position: "asc" } } },
      },
    },
  });

  return NextResponse.json({ wishlists: user?.wishlists ?? [] });
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { clerkId: userId } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const body = await req.json();
  const parsed = itemSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  // Verify wishlist belongs to user
  const wishlist = await prisma.wishlist.findFirst({
    where: { id: parsed.data.wishlistId, userId: user.id },
  });
  if (!wishlist) return NextResponse.json({ error: "Wishlist not found" }, { status: 404 });

  const item = await prisma.wishlistItem.create({ data: parsed.data });
  return NextResponse.json({ item }, { status: 201 });
}
