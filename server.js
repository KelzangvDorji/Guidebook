require('dotenv').config();
const express = require('express');
const path = require('node:path');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const { attachUser } = require('./src/middleware/auth');
const { ensureCsrfCookie } = require('./src/middleware/csrf');
const googleAuth = require('./src/utils/googleAuth');
const db = require('./src/db/db');

const app = express();

// Cache-busting for /public/* assets: static files are served with a long
// browser cache (maxAge below), so without a version marker a CSS/JS edit
// would stay invisible to anyone with a warm cache until it naturally
// expired. Bumping on every process start forces a fresh fetch after each
// restart/deploy while still letting the browser cache aggressively in between.
const ASSET_VERSION = Date.now().toString(36);

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src', 'views'));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https://*.googleusercontent.com'],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      workerSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// Safe defaults first, so that if a later middleware throws (e.g. malformed
// JSON body) before it can set the real values, error.ejs -> header.ejs can
// still render instead of throwing a second, uglier error of its own.
app.use((req, res, next) => {
  res.locals.user = null;
  res.locals.csrfToken = '';
  res.locals.currentPath = req.path;
  next();
});

app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(attachUser);
app.use(ensureCsrfCookie);

app.use((req, res, next) => {
  res.locals.csrfToken = req.csrfToken;
  res.locals.currentPath = req.path;
  res.locals.googleAuthEnabled = googleAuth.isConfigured();
  res.locals.v = ASSET_VERSION;
  next();
});

const globalLimiter = rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false });
app.use(globalLimiter);

app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));
app.use('/assets/landing-bg.png', (req, res) => res.sendFile(path.join(__dirname, 'Images', 'LandingPageBackgroundPicture.png')));

app.use('/', require('./src/routes/pages'));
app.use('/', require('./src/routes/auth'));
app.use('/api/payments', require('./src/routes/payments'));
app.use('/', require('./src/routes/reader'));
app.use('/', require('./src/routes/author'));
app.use('/', require('./src/routes/admin'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Page not found', message: 'The page you requested does not exist.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  if (req.path.startsWith('/api/')) {
    return res.status(status).json({ error: status === 400 ? 'Malformed request' : 'Unexpected server error' });
  }
  res.status(status).render('error', { title: 'Something went wrong', message: 'An unexpected error occurred. Please try again.' });
});

const PORT = process.env.PORT || 3000;
db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Bhutan Reads server running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
