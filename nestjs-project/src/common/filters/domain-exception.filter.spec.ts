import { ArgumentsHost } from '@nestjs/common';
import { DomainExceptionFilter } from './domain-exception.filter';
import {
  EmailAlreadyExistsException,
  EmailNotConfirmedException,
  InvalidCredentialsException,
  InvalidTokenException,
  TokenExpiredException,
  TokenReuseDetectedException,
  VideoNotFoundException,
  VideoAccessDeniedException,
  VideoNotReadyException,
  InvalidVideoStateException,
  UploadTooLargeException,
} from '../exceptions/domain.exception';

describe('DomainExceptionFilter', () => {
  let filter: DomainExceptionFilter;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new DomainExceptionFilter();
    mockJson = jest.fn();
    mockStatus = jest.fn().mockReturnValue({ json: mockJson });

    mockHost = {
      switchToHttp: () => ({
        getResponse: () => ({ status: mockStatus }),
        getRequest: () => ({ url: '/test', method: 'POST' }),
      }),
      getArgs: () => [],
      getArgByIndex: () => null,
      switchToRpc: () => ({}) as any,
      switchToWs: () => ({}) as any,
      getType: () => 'http',
    } as unknown as ArgumentsHost;
  });

  it('maps EmailAlreadyExistsException to 409 with EMAIL_ALREADY_EXISTS', () => {
    filter.catch(new EmailAlreadyExistsException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(409);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 409,
      error: 'EMAIL_ALREADY_EXISTS',
      message: 'Email is already registered',
    });
  });

  it('maps InvalidCredentialsException to 401 with INVALID_CREDENTIALS', () => {
    filter.catch(new InvalidCredentialsException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 401,
      error: 'INVALID_CREDENTIALS',
      message: expect.any(String),
    });
  });

  it('maps EmailNotConfirmedException to 403 with EMAIL_NOT_CONFIRMED', () => {
    filter.catch(new EmailNotConfirmedException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(403);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 403,
      error: 'EMAIL_NOT_CONFIRMED',
      message: expect.any(String),
    });
  });

  it('maps InvalidTokenException to 401 with INVALID_TOKEN', () => {
    filter.catch(new InvalidTokenException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 401,
      error: 'INVALID_TOKEN',
      message: expect.any(String),
    });
  });

  it('maps TokenExpiredException to 401 with TOKEN_EXPIRED', () => {
    filter.catch(new TokenExpiredException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 401,
      error: 'TOKEN_EXPIRED',
      message: expect.any(String),
    });
  });

  it('maps TokenReuseDetectedException to 401 with TOKEN_REUSE_DETECTED', () => {
    filter.catch(new TokenReuseDetectedException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 401,
      error: 'TOKEN_REUSE_DETECTED',
      message: expect.any(String),
    });
  });

  it('maps VideoNotFoundException to 404 with VIDEO_NOT_FOUND', () => {
    filter.catch(new VideoNotFoundException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(404);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 404,
      error: 'VIDEO_NOT_FOUND',
      message: expect.any(String),
    });
  });

  it('maps VideoAccessDeniedException to 403 with VIDEO_ACCESS_DENIED', () => {
    filter.catch(new VideoAccessDeniedException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(403);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 403,
      error: 'VIDEO_ACCESS_DENIED',
      message: expect.any(String),
    });
  });

  it('maps VideoNotReadyException to 409 with VIDEO_NOT_READY', () => {
    filter.catch(new VideoNotReadyException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(409);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 409,
      error: 'VIDEO_NOT_READY',
      message: expect.any(String),
    });
  });

  it('maps InvalidVideoStateException to 409 with INVALID_VIDEO_STATE', () => {
    filter.catch(new InvalidVideoStateException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(409);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 409,
      error: 'INVALID_VIDEO_STATE',
      message: expect.any(String),
    });
  });

  it('maps UploadTooLargeException to 413 with UPLOAD_TOO_LARGE', () => {
    filter.catch(new UploadTooLargeException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(413);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 413,
      error: 'UPLOAD_TOO_LARGE',
      message: expect.any(String),
    });
  });
});
