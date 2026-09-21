// Executed as a fixed program in the approved page. Credentials are supplied by
// the control plane from a private message/Keychain and are never exposed to the model.
export function chromeLoginPage(request) {
  const { baseUrl, username, password } = request;
  const base = new URL(baseUrl), current = new URL(location.href);
  const prefix = base.pathname.replace(/\/$/, '');
  const authPath = /\/(?:login|signin|sign-in|authenticate|auth|captcha|verify)(?:[/?#]|$)/i.test(current.pathname + current.hash);
  if (current.origin !== base.origin || (!authPath && !(current.pathname === prefix || current.pathname.startsWith(prefix + '/')))) {
    return { error: '浏览器已离开本次批准的登录范围' };
  }
  const visible = (el) => !!el?.getClientRects().length && getComputedStyle(el).visibility !== 'hidden'
    && getComputedStyle(el).display !== 'none' && !el.disabled;
  const passwords = [...document.querySelectorAll('input[type="password"]')].filter(visible);
  if (!passwords.length) return authPath ? { submitted: false, loginRequired: true, verificationRequired: true }
    : { submitted: false, loginRequired: false };
  const passwordInput = passwords[0];
  const form = passwordInput.closest('form');
  const scope = form ?? document;
  const userInputs = [...scope.querySelectorAll('input:not([type="password"]):not([type="hidden"]):not([type="submit"]):not([type="button"])')]
    .filter((el) => visible(el) && /^(?:text|email|tel|search)?$/i.test(el.type ?? 'text'));
  const named = userInputs.find((el) => /user|account|login|email|phone|mobile|账号|用户|邮箱|手机/i
    .test([el.name, el.id, el.autocomplete, el.placeholder, el.getAttribute('aria-label')].filter(Boolean).join(' ')));
  const beforePassword = userInputs.filter((el) => (el.compareDocumentPosition(passwordInput) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).at(-1);
  const userInput = named ?? beforePassword ?? userInputs[0];
  const setValue = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  if (userInput && !setValue(userInput, username)) return { error: '登录账号输入框不可填写' };
  if (!setValue(passwordInput, password)) return { error: '登录密码输入框不可填写' };
  const buttons = [...scope.querySelectorAll('button,input[type="submit"],[role="button"]')].filter(visible);
  const submit = buttons.find((el) => /登录|登入|sign\s*in|log\s*in|submit|确定|继续/i
    .test((el.innerText || el.value || el.getAttribute('aria-label') || '').trim()))
    ?? buttons.find((el) => el.type === 'submit');
  if (submit) submit.click();
  else if (form?.requestSubmit) form.requestSubmit();
  else return { error: '未找到登录提交按钮' };
  return { submitted: true, loginRequired: true };
}
