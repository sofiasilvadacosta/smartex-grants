import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Route Handlers are reachable directly, so authorize here rather than
  // relying on proxy.ts coverage alone.
  const session = await auth();
  if (!session?.user) return new Response(null, { status: 401 });

  const { id } = await params;
  const attachment = await prisma.attachment.findUnique({ where: { id } });
  if (!attachment) return new Response(null, { status: 404 });

  return new Response(new Uint8Array(attachment.content), {
    headers: {
      "Content-Type": attachment.mimeType,
      "Content-Length": String(attachment.sizeBytes),
      // Quote-escape the filename so a name containing a quote can't break out
      // of the header value.
      "Content-Disposition": `attachment; filename="${attachment.filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
