import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '@/config/config';
import { AppError } from '@/middleware/error.middleware';
import { UserModel, type KycStatus, type Role } from '@/models/user.model';

export interface AuthPayload {
  sub: string;
  email: string;
  role: Role;
  kycStatus: KycStatus;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

/** Callers may omit kycStatus (older sessions); it defaults to 'pending'. */
export type TokenPayload = Omit<AuthPayload, 'kycStatus'> & { kycStatus?: KycStatus };

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn as jwt.SignOptions['expiresIn'],
  });
}

export function verifyToken(token: string): AuthPayload {
  const decoded = jwt.verify(token, config.jwt.secret);
  if (typeof decoded === 'string' || !decoded.sub || !decoded.role) {
    throw new AppError('Invalid token', 401);
  }
  return {
    sub: decoded.sub,
    email: decoded.email,
    role: decoded.role,
    kycStatus: (decoded.kycStatus as KycStatus) ?? 'pending',
  };
}

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(new AppError('Authentication required', 401));
  }
  try {
    const payload = verifyToken(header.slice(7));
    // Verify latest role from db so role changes take effect immediately in existing sessions (#120)
    const user = UserModel.findById(payload.sub);
    if (!user || !user.active) {
      return next(new AppError('User not found or inactive', 401));
    }
    req.user = {
      sub: user.id,
      email: user.email,
      role: user.role,
      kycStatus: user.kycStatus,
    };
    next();
  } catch {
    next(new AppError('Invalid or expired token', 401));
  }
}

/** Restricts a route to the given roles. Must run after `authenticate`. */
export const authorize =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(new AppError('Authentication required', 401));
    if (!roles.includes(req.user.role)) {
      return next(new AppError('You do not have permission to do that', 403));
    }
    next();
  };
