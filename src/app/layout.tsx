import type { Metadata } from "next";
import { Cairo } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

// خط عربي جيد للواجهة (Cairo) — يعمل مع RTL بشكل ممتاز
const cairo = Cairo({
  variable: "--font-cairo",
  subsets: ["arabic", "latin"],
  weight: ["400", "500", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: "MCP Media Generator — لوحة الإدارة",
  description: "خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع — لوحة إدارة عربية",
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // RTL من أول لحظة + عربية + ثيم داكن مفعل مركزيًا لكل مكونات shadcn
    <html lang="ar" dir="rtl" className="dark" suppressHydrationWarning>
      <body className={`${cairo.variable} font-[family-name:var(--font-cairo)] antialiased bg-background text-foreground`}>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
