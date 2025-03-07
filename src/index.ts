import type { AppLoadContext, SessionStorage } from '@remix-run/server-runtime'
import type { AuthenticateOptions, StrategyVerifyCallback } from 'remix-auth'

import { redirect } from '@remix-run/server-runtime'
import { Strategy } from 'remix-auth'
import { verifyTOTP } from '@epic-web/totp'
import {
  generateSecret,
  generateTOTP,
  generateMagicLink,
  signJWT,
  verifyJWT,
} from './utils.js'
import { STRATEGY_NAME, FORM_FIELDS, SESSION_KEYS, ERRORS } from './constants.js'

/**
 * The TOTP generation configuration.
 */
export interface TOTPGenerationOptions {
  /**
   * The secret used to generate the OTP.
   * It should be Base32 encoded (Feel free to use: https://npm.im/thirty-two).
   *
   * @default random Base32 secret.
   */
  secret?: string

  /**
   * The algorithm used to generate the OTP.
   * @default 'SHA1'
   */
  algorithm?: string

  /**
   * The character set used to generate the OTP.
   * @default 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
   */
  charSet?: string

  /**
   * The number of digits used to generate the OTP.
   * @default 6
   */
  digits?: number

  /**
   * The number of seconds the OTP will be valid.
   * @default 60
   */
  period?: number

  /**
   * The max number of attempts the user can try to verify the OTP.
   * @default 3
   */
  maxAttempts?: number
}

/**
 * The Magic Link configuration.
 */
export interface MagicLinkGenerationOptions {
  /**
   * Whether to enable the Magic Link generation.
   * @default true
   */
  enabled?: boolean

  /**
   * The host URL for the Magic Link.
   * If omitted, it will be inferred from the Request.
   *
   * @default undefined
   */
  hostUrl?: string

  /**
   * The callback URL path for the Magic Link.
   * @default '/magic-link'
   */
  callbackPath?: string
}

/**
 * The store TOTP configuration.
 */
export interface StoreTOTPOptions {
  /**
   * The encrypted OTP.
   */
  hash: string

  /**
   * The status of the OTP.
   * @default true
   */
  active: boolean

  /**
   * The number of attempts the user tried to verify the OTP.
   * @default 0
   */
  attempts: number

  /**
   * The OTP expiration date.
   * @default Date.now() + TOTP generation period.
   */
  expiresAt?: Date | string
}

/**
 * The store TOTP method.
 * @param data The encrypted OTP.
 */
export interface StoreTOTP {
  (data: StoreTOTPOptions, context?: AppLoadContext): Promise<void>
}

/**
 * The send TOTP configuration.
 */
export interface SendTOTPOptions {
  /**
   * The email address provided by the user.
   */
  email: string

  /**
   * The decrypted OTP code.
   */
  code: string

  /**
   * The Magic Link URL.
   */
  magicLink?: string

  /**
   * The formData object.
   */
  form?: FormData

  /**
   * The Request object.
   */
  request: Request
}

/**
 * The sender email method.
 * @param options The send TOTP options.
 */
export interface SendTOTP {
  (options: SendTOTPOptions): Promise<void>
}

/**
 * The handle TOTP method.
 *
 * If `data` argument is provided, it will trigger a database update.
 * Otherwise, it will retrieve the encrypted OTP from database.
 *
 * @param hash The stored OTP from database.
 * @param data The data to update.
 */
export interface HandleTOTP {
  (
    hash: string,
    data?: { active?: boolean; attempts?: number; expiresAt?: Date | string },
    context?: AppLoadContext
  ): Promise<{
    hash?: string
    attempts: number
    active: boolean
    expiresAt?: Date | string | null
  } | null>
}

/**
 * The validate email method.
 * This can be useful to ensure it's not a disposable email address.
 *
 * @param email The email address to validate.
 */
export interface ValidateEmail {
  (email: string): Promise<void>
}

/**
 * The custom errors configuration.
 */
export interface CustomErrorsOptions {
  /**
   * The required email error message.
   */
  requiredEmail?: string

  /**
   * The invalid email error message.
   */
  invalidEmail?: string

  /**
   * The invalid TOTP error message.
   */
  invalidTotp?: string

  /**
   * The inactive TOTP error message.
   */
  inactiveTotp?: string
}

/**
 * The TOTP Strategy options.
 */
export interface TOTPStrategyOptions {
  /**
   * The secret used to sign the JWT.
   */
  secret: string

  /**
   * The maximum age the session can live.
   * @default undefined
   */
  maxAge?: number

  /**
   * The OTP generation configuration.
   */
  totpGeneration?: TOTPGenerationOptions

  /**
   * The Magic Link configuration.
   */
  magicLinkGeneration?: MagicLinkGenerationOptions

  /**
   * The store TOTP method.
   */
  storeTOTP: StoreTOTP

  /**
   * The send TOTP method.
   */
  sendTOTP: SendTOTP

  /**
   * The handle TOTP method.
   */
  handleTOTP: HandleTOTP

  /**
   * The validate email method.
   */
  validateEmail?: ValidateEmail

  /**
   * The custom errors configuration.
   */
  customErrors?: CustomErrorsOptions

  /**
   * The form input name used to get the email address.
   * @default "email"
   */
  emailFieldKey?: string

  /**
   * The form input name used to get the OTP.
   * @default "totp"
   */
  totpFieldKey?: string

  /**
   * The session key that stores the email address.
   * @default "auth:email"
   */
  sessionEmailKey?: string

  /**
   * The session key that stores the signed OTP.
   * @default "auth:totp"
   */
  sessionTotpKey?: string
}

/**
 * The verify method callback.
 * Returns required data to verify the user and handle additional logic.
 */
export interface TOTPVerifyParams {
  /**
   * The email address provided by the user.
   */
  email: string

  /**
   * The OTP code.
   */
  code?: string

  /**
   * The Magic Link URL.
   */
  magicLink?: string

  /**
   * The formData object from the Request.
   */
  form?: FormData

  /**
   * The Request object.
   */
  request: Request

  /**
   * The application context.
   */
  context?: AppLoadContext;
}

export class TOTPStrategy<User> extends Strategy<User, TOTPVerifyParams> {
  public name = STRATEGY_NAME

  private readonly secret: string
  private readonly maxAge: number | undefined
  private readonly totpGeneration: TOTPGenerationOptions
  private readonly magicLinkGeneration: MagicLinkGenerationOptions
  private readonly storeTOTP: StoreTOTP
  private readonly sendTOTP: SendTOTP
  private readonly handleTOTP: HandleTOTP
  private readonly validateEmail: ValidateEmail
  private readonly customErrors: CustomErrorsOptions
  private readonly emailFieldKey: string
  private readonly totpFieldKey: string
  private readonly sessionEmailKey: string
  private readonly sessionTotpKey: string

  private readonly _totpGenerationDefaults = {
    secret: generateSecret(),
    algorithm: 'SHA1',
    charSet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    digits: 6,
    period: 60,
    maxAttempts: 3,
  } satisfies TOTPGenerationOptions
  private readonly _magicLinkGenerationDefaults = {
    enabled: true,
    hostUrl: undefined,
    callbackPath: '/magic-link',
  } satisfies MagicLinkGenerationOptions
  private readonly _customErrorsDefaults = {
    requiredEmail: ERRORS.REQUIRED_EMAIL,
    invalidEmail: ERRORS.INVALID_EMAIL,
    invalidTotp: ERRORS.INVALID_TOTP,
    inactiveTotp: ERRORS.INACTIVE_TOTP,
  } satisfies CustomErrorsOptions

  constructor(
    options: TOTPStrategyOptions,
    verify: StrategyVerifyCallback<User, TOTPVerifyParams>,
  ) {
    super(verify)
    this.secret = options.secret
    this.maxAge = options.maxAge ?? undefined
    this.storeTOTP = options.storeTOTP
    this.sendTOTP = options.sendTOTP
    this.handleTOTP = options.handleTOTP
    this.validateEmail = options.validateEmail ?? this._validateEmailDefaults
    this.emailFieldKey = options.emailFieldKey ?? FORM_FIELDS.EMAIL
    this.totpFieldKey = options.totpFieldKey ?? FORM_FIELDS.TOTP
    this.sessionEmailKey = options.sessionEmailKey ?? SESSION_KEYS.EMAIL
    this.sessionTotpKey = options.sessionTotpKey ?? SESSION_KEYS.TOTP

    this.totpGeneration = {
      ...this._totpGenerationDefaults,
      ...options.totpGeneration,
    }
    this.magicLinkGeneration = {
      ...this._magicLinkGenerationDefaults,
      ...options.magicLinkGeneration,
    }
    this.customErrors = {
      ...this._customErrorsDefaults,
      ...options.customErrors,
    }
  }

  async authenticate(
    request: Request,
    sessionStorage: SessionStorage,
    options: AuthenticateOptions,
  ): Promise<User> {
    if (!this.secret) throw new Error(ERRORS.REQUIRED_ENV_SECRET)
    if (!options.successRedirect) throw new Error(ERRORS.REQUIRED_SUCCESS_REDIRECT_URL)

    const isPOST = request.method === 'POST'
    const isGET = request.method === 'GET'

    const session = await sessionStorage.getSession(request.headers.get('cookie'))
    const sessionEmail = session.get(this.sessionEmailKey)
    const sessionTotp = session.get(this.sessionTotpKey)

    let user: User | null = session.get(options.sessionKey) ?? null

    let formData: FormData | undefined = undefined
    let formDataEmail: string | undefined = undefined
    let formDataTotp: string | undefined = undefined
    let magicLinkTotp: string | undefined = undefined

    try {
      if (!user) {
        /**
         * 1st Authentication phase.
         */
        if (isPOST) {
          formData = await request.formData()
          const form = Object.fromEntries(formData)

          formDataEmail = form[this.emailFieldKey] && String(form[this.emailFieldKey])
          formDataTotp = form[this.totpFieldKey] && String(form[this.totpFieldKey])

          /**
           * Re-send TOTP.
           */
          if (!formDataEmail && !formDataTotp && sessionEmail && sessionTotp) {
            // Invalidate previous TOTP.
            await this.handleTOTP(sessionTotp, { active: false }, options.context)

            // Assign session email to form email.
            formDataEmail = sessionEmail
          }

          /**
           * Invalidate previous TOTP.
           * User has submitted a different email address.
           */
          if (
            formDataEmail &&
            sessionEmail &&
            formDataEmail !== sessionEmail &&
            sessionTotp
          ) {
            // Invalidate previous TOTP.
            await this.handleTOTP(sessionTotp, { active: false }, options.context)
          }

          /**
           * First TOTP request.
           */
          if (!formDataTotp) {
            if (!formDataEmail) throw new Error(this.customErrors.requiredEmail)
            await this.validateEmail(formDataEmail)

            // Generate and Sign TOTP.
            const { otp: _otp, ...totp } = generateTOTP({
              ...this.totpGeneration,
              secret: generateSecret(),
            })
            const signedTotp = signJWT(
              totp,
              this.totpGeneration.period ?? this._totpGenerationDefaults.period,
              this.secret,
            )

            // Generate Magic Link.
            const magicLink = generateMagicLink({
              ...this.magicLinkGeneration,
              param: this.totpFieldKey,
              code: _otp,
              request,
            })

            // Store TOTP.
            await this._saveOTP({ hash: signedTotp, active: true, attempts: 0 })

            // Update `expiresAt` database field (if exists).
            await this._handleExpiresAt(signedTotp, totp, options.context)

            // Send TOTP.
            await this._sendOTP({
              email: formDataEmail,
              code: _otp,
              magicLink,
              form: formData,
              request,
            })

            session.set(this.sessionEmailKey, formDataEmail)
            session.set(this.sessionTotpKey, signedTotp)
            session.unset(options.sessionErrorKey)

            throw redirect(options.successRedirect, {
              headers: {
                'set-cookie': await sessionStorage.commitSession(session, {
                  maxAge: this.maxAge,
                }),
              },
            })
          }
        }

        /**
         * 2nd Authentication phase.
         * Either via form submission or magic-link URL.
         */
        if (isGET && this.magicLinkGeneration.enabled) {
          const url = new URL(request.url)

          if (url.pathname !== this.magicLinkGeneration.callbackPath) {
            throw new Error(ERRORS.INVALID_MAGIC_LINK_PATH)
          }

          magicLinkTotp = url.searchParams.has(this.totpFieldKey)
            ? // @ts-expect-error - If param exists, it will be a string.
              decodeURIComponent(url.searchParams.get(this.totpFieldKey))
            : undefined
        }

        if ((isPOST && formDataTotp) || (isGET && magicLinkTotp)) {
          // Validation.
          if (isPOST && formDataTotp) {
            await this._validateTotp(sessionTotp, formDataTotp, options.context)
          }
          if (isGET && magicLinkTotp) {
            await this._validateTotp(sessionTotp, magicLinkTotp, options.context)
          }

          // Invalidation.
          await this.handleTOTP(sessionTotp, { active: false }, options.context)

          // Allow developer to handle the user verification.
          user = await this.verify({
            email: sessionEmail,
            form: formData,
            magicLink: magicLinkTotp,
            request,
            context: options.context
          })

          session.set(options.sessionKey, user)
          session.unset(this.sessionEmailKey)
          session.unset(this.sessionTotpKey)
          session.unset(options.sessionErrorKey)

          throw redirect(options.successRedirect, {
            headers: {
              'set-cookie': await sessionStorage.commitSession(session, {
                maxAge: this.maxAge,
              }),
            },
          })
        }
      }
    } catch (error) {
      // Allow responses to pass-through.
      if (error instanceof Response && error.status === 302) throw error
      if (error instanceof Error) {
        if (error.message === ERRORS.INVALID_JWT) {
          const dbTOTP = await this.handleTOTP(sessionTotp, undefined, options.context)
          if (!dbTOTP || !dbTOTP.hash) throw new Error(ERRORS.TOTP_NOT_FOUND)

          await this.handleTOTP(sessionTotp, { active: false }, options.context)

          return await this.failure(
            this.customErrors.inactiveTotp || ERRORS.INACTIVE_TOTP,
            request,
            sessionStorage,
            options,
            error,
          )
        }

        return await this.failure(error.message, request, sessionStorage, options, error)
      }
      if (typeof error === 'string') {
        return await this.failure(
          error,
          request,
          sessionStorage,
          options,
          new Error(error),
        )
      }
      return await this.failure(
        ERRORS.UNKNOWN_ERROR,
        request,
        sessionStorage,
        options,
        new Error(JSON.stringify(error, null, 2)),
      )
    }

    if (!user) throw new Error(ERRORS.USER_NOT_FOUND)

    return this.success(user, request, sessionStorage, options)
  }

  private async _validateEmailDefaults(email: string) {
    const regexEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/gm
    if (!regexEmail.test(email)) throw new Error(this.customErrors.invalidEmail)
  }

  private async _saveOTP(totp: StoreTOTPOptions, context?: AppLoadContext) {
    await this.storeTOTP(totp, context)
  }

  private async _sendOTP(data: SendTOTPOptions) {
    await this.sendTOTP({ ...data })
  }

  private async _validateTotp(sessionTotp: string, otp: string, context?: AppLoadContext) {
    // Retrieve encrypted TOTP from database.
    const dbTOTP = await this.handleTOTP(sessionTotp, undefined, context)
    if (!dbTOTP || !dbTOTP.hash) throw new Error(ERRORS.TOTP_NOT_FOUND)

    if (dbTOTP.active !== true) {
      throw new Error(this.customErrors.inactiveTotp)
    }

    const maxAttempts =
      this.totpGeneration.maxAttempts ?? this._totpGenerationDefaults.maxAttempts

    if (dbTOTP.attempts >= maxAttempts) {
      await this.handleTOTP(sessionTotp, { active: false }, context)
      throw new Error(this.customErrors.inactiveTotp)
    }

    // Decryption and Verification.
    const { iat, exp, ...totp } = verifyJWT(
      sessionTotp,
      this.secret,
    ) as Required<TOTPGenerationOptions> & { iat: number; exp: number }

    // Verify TOTP (@epic-web/totp).
    const isValid = verifyTOTP({ ...totp, otp })
    if (!isValid) {
      await this.handleTOTP(sessionTotp, { attempts: dbTOTP.attempts + 1 }, context)
      throw new Error(this.customErrors.invalidTotp)
    }
  }

  private async _handleExpiresAt(
    sessionTotp: string,
    totp: Partial<TOTPGenerationOptions>,
    context?: AppLoadContext
  ) {
    // Retrieve encrypted TOTP from database.
    const dbTOTP = await this.handleTOTP(sessionTotp, undefined, context)

    if (dbTOTP && 'expiresAt' in dbTOTP) {
      const newExpiresAt =
        Date.now() + (totp.period ?? this._totpGenerationDefaults.period) * 1000

      let formattedExpiresAt

      if (dbTOTP.expiresAt instanceof Date) {
        formattedExpiresAt = new Date(newExpiresAt)
      } else if (typeof dbTOTP.expiresAt === 'string') {
        formattedExpiresAt = new Date(newExpiresAt).toISOString()
      } else if (dbTOTP.expiresAt === null) {
        throw new Error(
          "Please initialize 'expiresAt' field in your database to either a Date or String type.",
        )
      }

      await this.handleTOTP(sessionTotp, {
        expiresAt: formattedExpiresAt,
      }, context)
    }
  }
}
