/// How the editor asks the current step "can we go on?": each step that
/// has rules registers a check that shows its own errors and answers.
class StepGate {
  bool Function()? _check;

  void register(bool Function() check) => _check = check;
  void unregister(bool Function() check) {
    // `==`, not identical: two tear-offs of the same method are equal, not identical.
    if (_check == check) _check = null;
  }

  bool get passes => _check?.call() ?? true;
}
