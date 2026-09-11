// Empire Google Auth Module — same OAuth client across all apps
// require('./google-auth')(app, express) to wire up
const passport   = require('passport');
const session    = require('express-session');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const jwt        = require('jsonwebtoken');

module.exports = function(app) {
  const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '';
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
  const CALLBACK_URL  = process.env.GOOGLE_CALLBACK_URL  || '';
  const JWT_SECRET    = process.env.JWT_SECRET           || 'empire-secret-2026';

  app.use(session({ secret: JWT_SECRET, resave: false, saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 } }));
  app.use(passport.initialize());
  app.use(passport.session());

  if (CLIENT_ID) {
    passport.use(new GoogleStrategy(
      { clientID: CLIENT_ID, clientSecret: CLIENT_SECRET, callbackURL: CALLBACK_URL },
      (_at, _rt, profile, done) => done(null, {
        id: profile.id, name: profile.displayName,
        email: (profile.emails||[])[0]?.value||'',
        avatar: (profile.photos||[])[0]?.value||''
      })
    ));
    passport.serializeUser((u, done) => done(null, u));
    passport.deserializeUser((u, done) => done(null, u));

    app.get('/auth/google', passport.authenticate('google', { scope: ['profile','email'] }));
    app.get('/auth/google/callback',
      passport.authenticate('google', { failureRedirect: '/?auth=failed' }),
      (req, res) => {
        const token = jwt.sign({ user: req.user }, JWT_SECRET, { expiresIn: '7d' });
        res.redirect('/?token=' + token);
      }
    );
  }

  app.get('/auth/me', (req, res) => {
    const auth = (req.headers.authorization||'').replace('Bearer ','');
    try { const d = jwt.verify(auth, JWT_SECRET); res.json({ ok:true, user:d.user }); }
    catch { res.json({ ok:false }); }
  });
  app.post('/auth/logout', (req, res) => { req.logout(()=>{}); res.json({ ok:true }); });
};
