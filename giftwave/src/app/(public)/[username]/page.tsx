import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { formatCurrency } from "@/lib/utils";
import GiftButton from "@/components/gifting/GiftButton";

interface Props {
  params: Promise<{ username: string }>;
}

export async function generateMetadata({ params }: Props) {
  const { username } = await params;
  const user = await prisma.user.findUnique({
    where: { username },
    select: { displayName: true, bio: true },
  });
  if (!user) return {};
  return {
    title: `${user.displayName}'s Wishlist — GiftWave`,
    description: user.bio ?? `Send a gift to ${user.displayName} on GiftWave.`,
  };
}

export default async function CreatorPage({ params }: Props) {
  const { username } = await params;

  const creator = await prisma.user.findUnique({
    where: { username, isActive: true },
    include: {
      wishlists: {
        where: { isPublic: true },
        include: {
          items: {
            where: { isReceived: false },
            orderBy: { position: "asc" },
          },
        },
      },
    },
  });

  if (!creator) notFound();

  const allItems = creator.wishlists.flatMap((w) => w.items);

  return (
    <main className="min-h-screen bg-gray-50">
      {/* Cover */}
      <div className="h-48 bg-gradient-to-r from-violet-500 to-purple-600">
        {creator.coverUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={creator.coverUrl} alt="cover" className="w-full h-full object-cover" />
        )}
      </div>

      {/* Profile */}
      <div className="max-w-2xl mx-auto px-4">
        <div className="-mt-12 mb-6">
          <div className="w-24 h-24 rounded-full border-4 border-white bg-violet-200 overflow-hidden">
            {creator.avatarUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={creator.avatarUrl} alt={creator.displayName} className="w-full h-full object-cover" />
            )}
          </div>
          <div className="mt-3">
            <h1 className="text-2xl font-bold text-gray-900">
              {creator.displayName}
              {creator.isVerified && (
                <span className="ml-2 text-violet-600 text-lg">✓</span>
              )}
            </h1>
            <p className="text-gray-500 text-sm">@{creator.username}</p>
            {creator.bio && <p className="mt-2 text-gray-700">{creator.bio}</p>}
          </div>
        </div>

        {/* Wishlists */}
        {creator.wishlists.map((wishlist) => (
          <div key={wishlist.id} className="mb-8">
            <h2 className="text-lg font-semibold mb-4">{wishlist.title}</h2>
            <div className="space-y-3">
              {wishlist.items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-4 bg-white rounded-2xl p-4 shadow-sm"
                >
                  {item.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.imageUrl}
                      alt={item.title}
                      className="w-16 h-16 object-cover rounded-xl flex-shrink-0"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{item.title}</p>
                    {item.description && (
                      <p className="text-sm text-gray-500 truncate">{item.description}</p>
                    )}
                    <p className="text-violet-600 font-semibold mt-1">
                      {formatCurrency(item.price, item.currency)}
                    </p>
                  </div>
                  <GiftButton item={item} creatorName={creator.displayName} />
                </div>
              ))}
              {wishlist.items.length === 0 && (
                <p className="text-gray-400 text-sm text-center py-8">No items yet.</p>
              )}
            </div>
          </div>
        ))}

        {allItems.length === 0 && (
          <p className="text-center text-gray-400 py-20">
            {creator.displayName} hasn&apos;t added any items yet.
          </p>
        )}

        <p className="text-center text-xs text-gray-400 py-8">
          Powered by{" "}
          <a href="/" className="text-violet-500 font-medium">
            GiftWave
          </a>{" "}
          — creators keep 100%
        </p>
      </div>
    </main>
  );
}
