# syntax=docker/dockerfile:1.7
# Container image for the AWS Lambda GitHub webhook gateway.
# The AWS Lambda base image supplies the Python runtime interface.

FROM public.ecr.aws/lambda/python:3.14

COPY app/requirements.txt ${LAMBDA_TASK_ROOT}/requirements.txt
RUN python -m pip install \
      --no-cache-dir \
      --requirement ${LAMBDA_TASK_ROOT}/requirements.txt \
      --target ${LAMBDA_TASK_ROOT}

COPY app/app.py ${LAMBDA_TASK_ROOT}/app.py

CMD ["app.lambda_handler"]
