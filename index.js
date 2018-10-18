import yar from 'yar';
import keycloak from 'keycloak-hapi';
import _ from 'lodash';

const KEYCLOAK_CONFIG_PREFIX = 'keycloak';
const SERVER_CONFIG_PREFIX = 'server';

const setupRequiredScope = (requiredRoles) => {
  const scope = {};
  for (const value of requiredRoles) {
      if (value === '') {
        continue;
      }

      const prefix = value[0];
      const type = (prefix === '+' ? 'required' : (prefix === '!' ? 'forbidden' : 'selection'));
      const clean = (type === 'selection' ? value : value.slice(1));
      scope[type] = scope[type] || [];
      scope[type].push(clean);
  }
  return scope;
};

const validateScope = (credentials, scope, type) => {
    if (!scope[type]) {
        return true;
    }
    const count = typeof credentials.scope === 'string' ?
        (scope[type].indexOf(credentials.scope) !== -1 ? 1 : 0) :
        _.intersection(scope[type], credentials.scope).length;
    if (type === 'forbidden') {
        return count === 0;
    }
    if (type === 'required') {
        return count === scope.required.length;
    }
    return !!count;
};

const getAuthorizationFor = (requiredRoles) => {
  const scope = setupRequiredScope(requiredRoles);
  return (credentials) => validateScope(credentials, scope, 'required') || 
      validateScope(credentials, scope, 'selection') || 
      validateScope(credentials, scope, 'forbidden');
};

const isLoginOrLogout = (request) => {
  const url = request.raw.req.url;
  return url.startsWith('/sso/login') || url.startsWith('/sso/logout');
};

const principalConversion = (principal) => {
  const modifiedPrincipal = ({ ...principal });
  delete modifiedPrincipal.accessToken;
  delete modifiedPrincipal.idToken;
  return modifiedPrincipal;
};

const interceptUnauthorizedRequests = (server, basePath, isAuthorized) => {
    server.ext('onPostAuth', (request, reply) => {
        return isLoginOrLogout(request) || !request.auth.credentials || isAuthorized(request.auth.credentials)
            ? reply.continue()
            : reply(`<p>The user has insufficient permissions to access this page. <a href="${basePath || ''}/sso/logout">Logout and try as another user</a></p>`);
    });
};

const propagateBearerToken = (server) => {
    server.ext('onPreHandler', function (request, reply) {
        if (!request.headers.authorization && request.auth.credentials && request.auth.credentials.accessToken) {
            request.headers.authorization = `Bearer ${request.auth.credentials.accessToken.token}`;
        }
        return reply.continue();
    });
};

export default function (kibana) {
    return new kibana.Plugin({
        require: ['elasticsearch', 'kibana'],
        name: 'keycloak-kibana',
        configPrefix: KEYCLOAK_CONFIG_PREFIX,
        uiExports: {
            chromeNavControls: [`plugins/keycloak-kibana/views/nav_control`],
            hacks: ['plugins/keycloak-kibana/hack']
        },
        config(Joi) {
            return Joi.object({
                serverUrl: Joi.string().required(),
                realm: Joi.string().required(),
                clientId: Joi.string().required(),
                clientSecret: Joi.string().required(),
                realmPublicKey: Joi.string(),
                minTimeBetweenJwksRequests: Joi.number().integer().default(10),
                principalNameAttribute: Joi.string().default('name'),
                session: Joi.object({
                    name: Joi.string().default('kc_session'),
                    cookieOptions: Joi.object({
                        password: Joi.string().min(32).required(),
                        isSecure: Joi.boolean().default(false),
                        isHttpOnly: Joi.boolean().default(false)
                    })
                }),
                requiredRoles: Joi.array().items(Joi.string()).default([]),
                propagateBearerToken: Joi.boolean().default(false),
                enabled: Joi.boolean().default(true)
            }).default();
        },
        init(server) {
            const basePath = server.config().get(SERVER_CONFIG_PREFIX).basePath;
            const keycloakConfig = Object.assign(server.config().get(KEYCLOAK_CONFIG_PREFIX), {
                basePath,
                principalConversion
            });
            return server.register({
                register: yar,
                options: {
                    storeBlank: false,
                    name: keycloakConfig.session.name,
                    maxCookieSize: 0,
                    cookieOptions: keycloakConfig.session.cookieOptions
                }
            }).then(() => {
                return server.register({
                    register: keycloak,
                    options: keycloakConfig
                });
            }).then(() => {
                server.auth.strategy('keycloak', 'keycloak', 'required');
                interceptUnauthorizedRequests(server, basePath, getAuthorizationFor(keycloakConfig.requiredRoles));
                if (keycloakConfig.propagateBearerToken) {
                    propagateBearerToken(server);
                }
            });
        }
    });
}
