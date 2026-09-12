/**
 * A predictable error shape for the whole API: every failure carries an HTTP
 * status and a stable machine-readable `code` the frontend can branch on.
 */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(code, message, details) {
    return new ApiError(400, code, message, details);
  }
  static unauthorized(code = 'unauthorized', message = 'You must be signed in.') {
    return new ApiError(401, code, message);
  }
  static forbidden(code = 'forbidden', message = 'You do not have permission to do that.') {
    return new ApiError(403, code, message);
  }
  static notFound(code = 'not_found', message = 'Not found.') {
    return new ApiError(404, code, message);
  }
  static conflict(code, message) {
    return new ApiError(409, code, message);
  }
  static tooMany(code = 'rate_limited', message = 'Too many requests. Please slow down.') {
    return new ApiError(429, code, message);
  }
}

/** Wraps an async route handler so rejected promises reach the error handler. */
export const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

export function notFoundHandler(req, res, next) {
  if (req.path.startsWith('/api/')) {
    next(ApiError.notFound('route_not_found', `No API route for ${req.method} ${req.path}.`));
    return;
  }
  next();
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
export function errorHandler(err, req, res, next) {
  const isApiError = err instanceof ApiError;
  const status = isApiError ? err.status : err.status || 500;

  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  }

  // Multer surfaces upload problems with its own codes.
  if (err.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: { code: 'file_too_large', message: 'That file is too large.' } });
    return;
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    res.status(413).json({ error: { code: 'too_many_files', message: 'Too many files at once.' } });
    return;
  }

  res.status(status).json({
    error: {
      code: isApiError ? err.code : 'internal_error',
      message: isApiError ? err.message : 'Something went wrong on our end.',
      ...(isApiError && err.details ? { details: err.details } : {}),
    },
  });
}
