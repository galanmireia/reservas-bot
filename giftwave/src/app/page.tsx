import Link from "next/link";

export default function HomePage() {
  return (
    <main className="flex flex-col min-h-screen">
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
        <span className="text-xl font-bold text-violet-600">GiftWave</span>
        <div className="flex items-center gap-4">
          <Link href="/sign-in" className="text-sm text-gray-600 hover:text-gray-900">
            Sign in
          </Link>
          <Link
            href="/sign-up"
            className="text-sm bg-violet-600 text-white px-4 py-2 rounded-full hover:bg-violet-700 transition-colors"
          >
            Get started free
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="flex flex-col items-center text-center px-6 py-24 bg-gradient-to-b from-violet-50 to-white">
        <div className="inline-flex items-center gap-2 bg-violet-100 text-violet-700 text-sm font-medium px-4 py-1.5 rounded-full mb-6">
          🎁 Trusted by creators worldwide
        </div>
        <h1 className="text-5xl font-extrabold tracking-tight text-gray-900 max-w-2xl leading-tight">
          Gift your favorite creators.{" "}
          <span className="text-violet-600">They keep 100%.</span>
        </h1>
        <p className="mt-6 text-xl text-gray-500 max-w-xl">
          Send gifts, cash, and digital items with complete privacy. No commissions, instant
          payouts, zero chargebacks.
        </p>
        <div className="mt-10 flex flex-col sm:flex-row gap-4">
          <Link
            href="/sign-up"
            className="bg-violet-600 text-white px-8 py-3.5 rounded-full text-lg font-semibold hover:bg-violet-700 transition-colors"
          >
            Create your wishlist — free
          </Link>
          <Link
            href="#how-it-works"
            className="border border-gray-200 text-gray-700 px-8 py-3.5 rounded-full text-lg font-semibold hover:bg-gray-50 transition-colors"
          >
            How it works
          </Link>
        </div>
        <p className="mt-4 text-sm text-gray-400">
          Join with a referral link? Get <strong className="text-gray-600">$5 free</strong> on your first gift received.
        </p>
      </section>

      {/* Stats */}
      <section className="grid grid-cols-3 gap-8 max-w-3xl mx-auto px-6 py-16 text-center">
        <div>
          <p className="text-4xl font-extrabold text-violet-600">0%</p>
          <p className="mt-1 text-gray-500">Commission on gifts</p>
        </div>
        <div>
          <p className="text-4xl font-extrabold text-violet-600">100%</p>
          <p className="mt-1 text-gray-500">Privacy protected</p>
        </div>
        <div>
          <p className="text-4xl font-extrabold text-violet-600">Instant</p>
          <p className="mt-1 text-gray-500">Payouts available</p>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="bg-gray-50 py-20 px-6">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-12">How it works</h2>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                step: "1",
                title: "Create your profile",
                desc: "Set up your wishlist with products, cash requests, or digital content. Your address is always private.",
              },
              {
                step: "2",
                title: "Share your link",
                desc: "Share your GiftWave link anywhere — bio, streams, social media. Fans can send gifts in seconds.",
              },
              {
                step: "3",
                title: "Get paid instantly",
                desc: "Receive 100% of every gift with no commission. Withdraw anytime to your bank or PayPal.",
              },
            ].map((item) => (
              <div key={item.step} className="bg-white rounded-2xl p-6 shadow-sm">
                <div className="w-10 h-10 bg-violet-100 text-violet-600 rounded-full flex items-center justify-center font-bold text-lg mb-4">
                  {item.step}
                </div>
                <h3 className="font-semibold text-lg mb-2">{item.title}</h3>
                <p className="text-gray-500 text-sm leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Referral CTA */}
      <section className="py-20 px-6 text-center bg-violet-600 text-white">
        <h2 className="text-3xl font-bold mb-4">Earn by sharing GiftWave</h2>
        <p className="text-violet-200 max-w-xl mx-auto mb-8">
          Bring a creator friend and earn <strong className="text-white">$10 cash + 1% of their earnings</strong> for
          12 months. They get <strong className="text-white">$5 free</strong> when they receive their first gift.
        </p>
        <Link
          href="/sign-up"
          className="bg-white text-violet-600 px-8 py-3.5 rounded-full text-lg font-semibold hover:bg-violet-50 transition-colors"
        >
          Start referring today
        </Link>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-100 py-8 px-6 text-center text-sm text-gray-400">
        © {new Date().getFullYear()} GiftWave. Built for creators.
      </footer>
    </main>
  );
}
