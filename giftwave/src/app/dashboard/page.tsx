import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { formatCurrency } from "@/lib/utils";
import Link from "next/link";

export default async function DashboardPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const user = await prisma.user.findUnique({
    where: { clerkId: userId },
    include: {
      receivedTransactions: {
        where: { status: "COMPLETED" },
        orderBy: { createdAt: "desc" },
        take: 10,
        include: { wishlistItem: true },
      },
      referralEarnings: {
        orderBy: { createdAt: "desc" },
        take: 5,
      },
      _count: { select: { referrals: true } },
    },
  });

  if (!user) redirect("/onboarding");

  const pendingReferralEarnings = user.referralEarnings
    .filter((e) => e.status === "PENDING")
    .reduce((sum, e) => sum + e.amount, 0);

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between">
        <span className="text-xl font-bold text-violet-600">GiftWave</span>
        <div className="flex items-center gap-4 text-sm">
          <Link href={`/${user.username}`} className="text-gray-500 hover:text-gray-900">
            View profile →
          </Link>
          <Link href="/dashboard/wishlists" className="text-gray-500 hover:text-gray-900">
            Wishlists
          </Link>
          <Link href="/dashboard/settings" className="text-gray-500 hover:text-gray-900">
            Settings
          </Link>
        </div>
      </nav>

      <div className="max-w-4xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold mb-6">
          Hey, {user.displayName} 👋
        </h1>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          {[
            { label: "Available balance", value: formatCurrency(user.balance), highlight: true },
            { label: "Total received", value: formatCurrency(user.totalReceived) },
            { label: "Referrals", value: user._count.referrals.toString() },
            { label: "Referral earnings", value: formatCurrency(pendingReferralEarnings) },
          ].map((stat) => (
            <div
              key={stat.label}
              className={`rounded-2xl p-4 ${stat.highlight ? "bg-violet-600 text-white" : "bg-white"}`}
            >
              <p className={`text-sm ${stat.highlight ? "text-violet-200" : "text-gray-500"}`}>
                {stat.label}
              </p>
              <p className={`text-2xl font-bold mt-1 ${stat.highlight ? "text-white" : "text-gray-900"}`}>
                {stat.value}
              </p>
            </div>
          ))}
        </div>

        {/* Referral link */}
        <div className="bg-white rounded-2xl p-5 mb-6 border border-violet-100">
          <h2 className="font-semibold mb-1">Your referral link</h2>
          <p className="text-sm text-gray-500 mb-3">
            Earn $10 + 1% of their earnings for 12 months when a creator joins through your link.
          </p>
          <div className="flex gap-2">
            <input
              readOnly
              value={`${process.env.NEXT_PUBLIC_APP_URL}/sign-up?ref=${user.referralCode}`}
              className="flex-1 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-sm"
            />
            <button className="bg-violet-600 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-violet-700 transition-colors">
              Copy
            </button>
          </div>
        </div>

        {/* Recent gifts */}
        <div className="bg-white rounded-2xl p-5">
          <h2 className="font-semibold mb-4">Recent gifts</h2>
          {user.receivedTransactions.length === 0 ? (
            <div className="text-center py-10">
              <p className="text-gray-400 mb-3">No gifts yet.</p>
              <Link
                href={`/${user.username}`}
                className="text-violet-600 text-sm font-medium hover:underline"
              >
                Share your profile to get started →
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {user.receivedTransactions.map((tx) => (
                <div key={tx.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                  <div>
                    <p className="font-medium text-sm">
                      {tx.isAnonymous ? "Anonymous" : (tx.fanName ?? "Someone")}
                    </p>
                    <p className="text-xs text-gray-400">
                      {tx.wishlistItem?.title ?? "Cash gift"} •{" "}
                      {new Date(tx.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <p className="font-semibold text-green-600">
                    +{formatCurrency(tx.creatorReceives, tx.currency)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
