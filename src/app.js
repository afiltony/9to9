import path from 'node:path';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { config, ROOT } from './config.js';
import * as fmt from './lib/format.js';
import { can, csrfToken, MySqlSessionStore } from './lib/security.js';
import adminRoutes from './routes/admin.js';
import manageRoutes from './routes/manage.js';
import publicRoutes, { loadEvent } from './routes/public.js';
import reportRoutes from './routes/reports.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.disable('x-powered-by');

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        mediaSrc: ["'self'", 'blob:'],
        fontSrc: ["'self'"],
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  app.use('/static', express.static(path.join(ROOT, 'public'), { maxAge: config.isProd ? '1d' : 0 }));
  app.use('/static/fonts', express.static(path.join(ROOT, 'node_modules', '@fontsource'), { maxAge: '30d', immutable: true }));
  app.get('/static/vendor/html5-qrcode.min.js', (req, res) => {
    res.sendFile(path.join(ROOT, 'node_modules', 'html5-qrcode', 'html5-qrcode.min.js'));
  });

  app.use(express.urlencoded({ extended: false, limit: '200kb' }));

  app.use(session({
    name: 'nine.sid',
    store: new MySqlSessionStore(),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 12 * 3600 * 1000 },
  }));

  app.use((req, res, next) => {
    res.locals.fmt = fmt;
    res.locals.admin = req.session.admin || null;
    res.locals.can = (perm) => can(req.session.admin, perm);
    res.locals.csrf = () => csrfToken(req);
    res.locals.flash = req.session.flash || null;
    if (req.session.flash) delete req.session.flash;
    res.locals.path = req.path;
    res.locals.baseUrl = config.baseUrl;
    // set by loadEvent; defaults keep error pages renderable without an event
    res.locals.event = null;
    res.locals.content = null;
    res.locals.state = null;
    res.locals.isAdminArea = req.path.startsWith('/admin') || req.path.startsWith('/checkin');
    next();
  });

  app.use(loadEvent);
  app.use(publicRoutes);
  app.use(adminRoutes);
  app.use(manageRoutes);
  app.use(reportRoutes);

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Page not found', message: 'The page you are looking for does not exist.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    // the error may have happened before the locals middleware ran
    if (!res.locals.fmt) Object.assign(res.locals, { fmt, admin: null, can: () => false, csrf: () => '', path: req.path, flash: null, baseUrl: config.baseUrl, isAdminArea: false, event: null, content: null, state: null });
    res.status(err.status || 500).render('error', {
      title: 'Something went wrong',
      message: 'An unexpected error occurred. Please try again, or contact the help desk if it keeps happening.',
    });
  });

  return app;
}
