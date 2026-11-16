'use strict';

class AppError extends Error {
  constructor(code, message, status = 422, details = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function fail(code, message, status = 422, details = null) {
  throw new AppError(code, message, status, details);
}

module.exports = { AppError, fail };
