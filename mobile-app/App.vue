<script>
export default {
  onLaunch() {},
};
</script>

<style>
page {
  min-height: 100%;
  background: #f5f6f8;
  color: #111827;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

view,
text,
button,
textarea,
input {
  box-sizing: border-box;
}

button {
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  border: 0;
  border-radius: 6px;
  padding: 0;
  font-size: 15px;
  line-height: 1;
}

button::after {
  border: 0;
}
</style>
