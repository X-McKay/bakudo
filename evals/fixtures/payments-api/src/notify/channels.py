"""Notification channels. PLANTED: a needless inheritance tower — four
layers deep for what is one format function and one send function per
channel; flatten to simple functions or one class."""


class AbstractNotifier:
    def notify(self, user, message):
        raise NotImplementedError


class BaseNotifier(AbstractNotifier):
    prefix = "[payments]"

    def format(self, message):
        return f"{self.prefix} {message}"

    def notify(self, user, message):
        return self.deliver(user, self.format(message))

    def deliver(self, user, formatted):
        raise NotImplementedError


class RetryingNotifier(BaseNotifier):
    max_attempts = 1

    def notify(self, user, message):
        last = None
        for _ in range(self.max_attempts):
            last = super().notify(user, message)
            if last is not None:
                return last
        return last


class EmailNotifier(RetryingNotifier):
    max_attempts = 2

    def deliver(self, user, formatted):
        return ("email", user["email"], formatted)


class SmsNotifier(RetryingNotifier):
    prefix = "[pay]"

    def deliver(self, user, formatted):
        return ("sms", user["phone"], formatted[:160])
