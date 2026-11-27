import { ServiceUnavailableException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export function issueConvexToken(userId: string): string {
  const issuer = process.env.ANCHOR_AUTH_ISSUER;
  const privateKey = process.env.ANCHOR_CONVEX_SIGNING_KEY;
  if (!issuer || !privateKey) {
    throw new ServiceUnavailableException(
      'Convex authentication is not configured',
    );
  }
  return new JwtService({ privateKey }).sign(
    {},
    {
      algorithm: 'RS256',
      keyid: 'anchor-convex',
      audience: 'anchor',
      issuer,
      subject: userId,
      expiresIn: 60,
    },
  );
}
